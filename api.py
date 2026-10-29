#!/usr/bin/env python3
"""Local HTTP API for the Expo face-attendance app."""

import base64
import binascii
import csv
import json
import os
import threading
import uuid
from datetime import datetime
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from attendance import (
    ATTENDANCE_PATH,
    DATA_DIR,
    FACE_SIZE,
    MODEL_PATH,
    PROFILE_PATH,
    REGISTRATION_SAMPLES,
    detect_faces,
    eye_state,
    load_cascades,
    load_profile,
    normalized_face,
)


app = FastAPI(title="Face Attendance API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_IMAGE_BYTES = 5_000_000
MATCH_THRESHOLD = 70.0
state_lock = threading.Lock()
face_cascade = None
eye_cascade = None
registration = None
attendance_sessions = {}


class RegisterStart(BaseModel):
    name: str


class ImageFrame(BaseModel):
    image: str


class AttendanceStart(BaseModel):
    action: Literal["clock-in", "clock-out"]


class AttendanceFrame(BaseModel):
    session_id: str
    image: str


class SessionRequest(BaseModel):
    session_id: str


def attendance_summary(name):
    matching_events = []

    if ATTENDANCE_PATH.exists():
        try:
            with ATTENDANCE_PATH.open(newline="", encoding="utf-8") as file:
                for event in csv.DictReader(file):
                    if event.get("name") != name:
                        continue
                    try:
                        timestamp = datetime.fromisoformat(event["timestamp"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    action = event.get("action", "")
                    if action in ("clock-in", "clock-out"):
                        matching_events.append(
                            {
                                "timestamp": timestamp.isoformat(timespec="seconds"),
                                "name": name,
                                "action": action,
                            }
                        )
        except OSError as error:
            raise HTTPException(
                status_code=500, detail=f"Could not read attendance: {error}"
            ) from error

    clock_in_event = None
    clock_out_event = None
    for event in matching_events:
        if event["action"] == "clock-in":
            clock_in_event = event
            clock_out_event = None
        elif event["action"] == "clock-out":
            clock_out_event = event

    last_event = matching_events[-1] if matching_events else None
    clocked_in = last_event is not None and last_event["action"] == "clock-in"
    duration_minutes = 0
    if clock_in_event:
        end_time = (
            datetime.now().astimezone()
            if clocked_in
            else datetime.fromisoformat(clock_out_event["timestamp"])
            if clock_out_event
            else datetime.fromisoformat(clock_in_event["timestamp"])
        )
        duration_minutes = max(
            0,
            int(
                (
                    end_time
                    - datetime.fromisoformat(clock_in_event["timestamp"])
                ).total_seconds()
                // 60
            ),
        )

    return {
        "clocked_in": clocked_in,
        "clock_in_time": clock_in_event["timestamp"] if clock_in_event else None,
        "clock_out_time": clock_out_event["timestamp"] if clock_out_event else None,
        "duration_minutes": duration_minutes,
    }


def get_cascades():
    global face_cascade, eye_cascade
    if face_cascade is None or eye_cascade is None:
        face_cascade, eye_cascade = load_cascades()
    return face_cascade, eye_cascade


def decode_frame(encoded_image):
    if len(encoded_image) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        raise HTTPException(status_code=413, detail="Image is too large.")
    if encoded_image.startswith("data:"):
        _, separator, encoded_image = encoded_image.partition(",")
        if not separator:
            raise HTTPException(status_code=400, detail="Invalid image data URL.")
    try:
        image_bytes = base64.b64decode(encoded_image, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=400, detail="Invalid base64 image.") from error
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or too large.")
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not decode the image.")
    if image.shape[0] * image.shape[1] > 12_000_000:
        raise HTTPException(status_code=413, detail="Image dimensions are too large.")
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


@app.get("/health")
def health():
    try:
        get_cascades()
    except RuntimeError as error:
        raise HTTPException(
            status_code=503, detail=f"OpenCV face-recognition setup failed: {error}"
        ) from error
    return {"status": "ok"}


@app.get("/api/status")
def status():
    name = None
    if MODEL_PATH.is_file() and PROFILE_PATH.is_file():
        try:
            profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
            if not isinstance(profile, dict) or not isinstance(profile.get("name"), str):
                raise ValueError("The registered profile is invalid.")
            name = profile["name"]
        except (OSError, json.JSONDecodeError):
            raise HTTPException(status_code=500, detail="Could not read the profile.")
        except ValueError as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    events = []
    if ATTENDANCE_PATH.is_file():
        try:
            with ATTENDANCE_PATH.open(newline="", encoding="utf-8") as file:
                events = list(csv.DictReader(file))[-10:][::-1]
        except OSError as error:
            raise HTTPException(
                status_code=500, detail=f"Could not read attendance: {error}"
            ) from error

    summary = attendance_summary(name) if name else {
        "clocked_in": False,
        "clock_in_time": None,
        "clock_out_time": None,
        "duration_minutes": 0,
    }
    return {
        "registered": name is not None,
        "name": name,
        "events": events,
        **summary,
    }


@app.post("/api/register/start")
def start_registration(request: RegisterStart):
    name = request.name.strip()
    if not name or len(name) > 100:
        raise HTTPException(
            status_code=400, detail="Enter a name between 1 and 100 characters."
        )
    with state_lock:
        global registration
        registration = {"name": name, "samples": []}
    return {"status": "capturing", "required": REGISTRATION_SAMPLES, "collected": 0}


@app.post("/api/register/frame")
def register_frame(request: ImageFrame):
    global registration
    gray = decode_frame(request.image)
    faces, _ = get_cascades()
    detected = detect_faces(gray, faces)
    if len(detected) == 0:
        return {"status": "face_not_found"}
    if len(detected) > 1:
        return {"status": "multiple_faces"}

    face = normalized_face(gray, tuple(int(value) for value in detected[0]))
    with state_lock:
        if registration is None:
            raise HTTPException(status_code=409, detail="Start registration first.")
        registration["samples"].append(face)
        collected = len(registration["samples"])
        if collected < REGISTRATION_SAMPLES:
            return {
                "status": "capturing",
                "required": REGISTRATION_SAMPLES,
                "collected": collected,
            }

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        recognizer = cv2.face.LBPHFaceRecognizer_create()
        recognizer.train(
            registration["samples"],
            np.zeros(REGISTRATION_SAMPLES, dtype=np.int32),
        )
        recognizer.write(str(MODEL_PATH))
        PROFILE_PATH.write_text(
            json.dumps({"name": registration["name"]}, indent=2) + "\n",
            encoding="utf-8",
        )
        name = registration["name"]
        registration = None

    return {"status": "registered", "name": name, "collected": collected}


@app.post("/api/register/cancel")
def cancel_registration():
    global registration
    with state_lock:
        registration = None
    return {"status": "cancelled"}


@app.post("/api/attendance/start")
def start_attendance(request: AttendanceStart):
    try:
        name, recognizer = load_profile()
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    summary = attendance_summary(name)
    if request.action == "clock-in" and summary["clocked_in"]:
        raise HTTPException(
            status_code=409,
            detail=f"Already clocked in at {summary['clock_in_time']}. Clock out first.",
        )
    if request.action == "clock-out" and not summary["clocked_in"]:
        raise HTTPException(
            status_code=409, detail="Clock in before trying to clock out."
        )
    session_id = str(uuid.uuid4())
    with state_lock:
        attendance_sessions[session_id] = {
            "action": request.action,
            "name": name,
            "recognizer": recognizer,
            "open_seen": False,
            "closed_frames": 0,
        }
    return {"session_id": session_id, "name": name, "status": "waiting_for_face"}


@app.post("/api/attendance/frame")
def attendance_frame(request: AttendanceFrame):
    gray = decode_frame(request.image)
    faces, eyes = get_cascades()
    with state_lock:
        session = attendance_sessions.get(request.session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Attendance session not found.")
        detected = detect_faces(gray, faces)
        if len(detected) == 0:
            session["open_seen"] = False
            session["closed_frames"] = 0
            return {"status": "face_not_found", "message": "Face not found"}
        if len(detected) > 1:
            session["open_seen"] = False
            session["closed_frames"] = 0
            return {
                "status": "multiple_faces",
                "message": "Only one person should be visible",
            }

        rectangle = tuple(int(value) for value in detected[0])
        prediction, confidence = session["recognizer"].predict(
            normalized_face(gray, rectangle)
        )
        if prediction != 0 or confidence > MATCH_THRESHOLD:
            session["open_seen"] = False
            session["closed_frames"] = 0
            return {"status": "not_matched", "message": "Face not matched"}

        eyes_open = eye_state(gray, rectangle, eyes)
        if eyes_open:
            blink_seen = session["open_seen"] and session["closed_frames"] >= 1
            session["open_seen"] = True
            session["closed_frames"] = 0
        else:
            blink_seen = False
            if session["open_seen"]:
                session["closed_frames"] += 1

        if not blink_seen:
            return {
                "status": "blink_required",
                "message": "Face matched. Blink to confirm.",
            }

        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        is_new_file = not ATTENDANCE_PATH.exists()
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with ATTENDANCE_PATH.open("a", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            if is_new_file:
                writer.writerow(["timestamp", "name", "action"])
            writer.writerow([timestamp, session["name"], session["action"]])
        attendance_sessions.pop(request.session_id)
        return {
            "status": "recorded",
            "message": f"{session['action']} recorded for {session['name']}.",
            "name": session["name"],
            "action": session["action"],
            "timestamp": timestamp,
        }


@app.post("/api/attendance/cancel")
def cancel_attendance(request: SessionRequest):
    with state_lock:
        attendance_sessions.pop(request.session_id, None)
    return {"status": "cancelled"}
