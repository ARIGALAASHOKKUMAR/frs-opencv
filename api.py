#!/usr/bin/env python3
"""Supabase-authenticated OpenCV face attendance API."""

import base64
import binascii
import hashlib
import json
import os
import tempfile
import threading
import time
import uuid
from datetime import datetime
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from attendance import (
    REGISTRATION_SAMPLES,
    detect_faces,
    eye_state,
    load_cascades,
    normalized_face,
)


app = FastAPI(title="APFD Face Attendance API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
MAX_IMAGE_BYTES = 5_000_000
MAX_PROCESSING_WIDTH = 640
MATCH_THRESHOLD = 70.0
AUTH_CACHE_SECONDS = 60
state_lock = threading.Lock()
auth_cache_lock = threading.Lock()
face_cascade = None
eye_cascade = None
registrations = {}
attendance_sessions = {}
verified_tokens = {}


class RegisterStart(BaseModel):
    name: str
    employee_id: str


class ImageFrame(BaseModel):
    image: str


class AttendanceStart(BaseModel):
    action: Literal["clock-in", "clock-out"]


class AttendanceFrame(BaseModel):
    session_id: str
    image: str


class SessionRequest(BaseModel):
    session_id: str


def require_supabase_config():
    if not SUPABASE_URL or not SUPABASE_PUBLISHABLE_KEY:
        raise HTTPException(
            status_code=503,
            detail="Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.",
        )


def supabase_request(method, path, user=None, payload=None, params=None, prefer=None):
    require_supabase_config()
    url = f"{SUPABASE_URL}{path}"
    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"
    headers = {
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Accept": "application/json",
    }
    if user:
        headers["Authorization"] = f"Bearer {user['token']}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=12) as response:
            response_body = response.read()
    except HTTPError as error:
        detail = "Supabase rejected the request."
        try:
            error_body = json.loads(error.read().decode("utf-8"))
            detail = (
                error_body.get("message")
                or error_body.get("msg")
                or error_body.get("error_description")
                or detail
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        if error.code == 401:
            raise HTTPException(status_code=401, detail="Your session expired. Sign in again.") from error
        if error.code == 403:
            raise HTTPException(
                status_code=403,
                detail="Supabase denied access. Check the database schema and row-level security policies.",
            ) from error
        if error.code == 409 or "duplicate key" in detail.lower():
            raise HTTPException(status_code=409, detail=detail) from error
        if 400 <= error.code < 500:
            raise HTTPException(status_code=400, detail=detail) from error
        raise HTTPException(
            status_code=502, detail="Supabase could not complete the database request."
        ) from error
    except (URLError, TimeoutError, OSError) as error:
        raise HTTPException(
            status_code=503, detail="Could not connect to Supabase. Try again."
        ) from error
    if not response_body:
        return None
    try:
        return json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=502, detail="Supabase returned an invalid response."
        ) from error


def authenticate(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    require_supabase_config()
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue.")

    cache_key = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.monotonic()
    with auth_cache_lock:
        cached = verified_tokens.get(cache_key)
        if cached and cached["expires_at"] > now:
            return {**cached["user"], "token": token}
        expired_keys = [
            key for key, value in verified_tokens.items() if value["expires_at"] <= now
        ]
        for key in expired_keys:
            verified_tokens.pop(key, None)

    request = Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "apikey": SUPABASE_PUBLISHABLE_KEY,
            "Authorization": f"Bearer {token}",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=8) as response:
            user = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        if error.code in (401, 403):
            raise HTTPException(status_code=401, detail="Your session expired. Sign in again.") from error
        raise HTTPException(status_code=503, detail="Could not verify your Supabase session.") from error
    except (URLError, TimeoutError, OSError) as error:
        raise HTTPException(status_code=503, detail="Could not connect to Supabase Auth.") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail="Supabase Auth returned an invalid response.") from error

    user_id = user.get("id")
    if not isinstance(user_id, str):
        raise HTTPException(status_code=401, detail="Supabase returned an invalid user session.")
    safe_user = {
        "id": user_id,
        "email": user.get("email", ""),
        "user_metadata": user.get("user_metadata") or {},
    }
    with auth_cache_lock:
        if len(verified_tokens) >= 2048:
            verified_tokens.clear()
        verified_tokens[cache_key] = {
            "user": safe_user,
            "expires_at": now + AUTH_CACHE_SECONDS,
        }
    return {**safe_user, "token": token}


def db_rows(path, user, params):
    result = supabase_request("GET", path, user=user, params=params)
    if not isinstance(result, list):
        raise HTTPException(status_code=502, detail="Supabase returned invalid table data.")
    return result


def get_profile(user, include_model=False):
    fields = "user_id,employee_id,full_name,face_model" if include_model else "user_id,employee_id,full_name"
    rows = db_rows(
        "/rest/v1/employee_profiles",
        user,
        {"select": fields, "user_id": f"eq.{user['id']}", "limit": "1"},
    )
    return rows[0] if rows else None


def get_events(user, limit=100):
    return db_rows(
        "/rest/v1/attendance_events",
        user,
        {
            "select": "id,timestamp,name,action",
            "user_id": f"eq.{user['id']}",
            "order": "timestamp.desc",
            "limit": str(limit),
        },
    )


def attendance_summary(events):
    ordered = sorted(events, key=lambda event: event["timestamp"])
    clock_in_event = None
    clock_out_event = None
    for event in ordered:
        if event["action"] == "clock-in":
            clock_in_event = event
            clock_out_event = None
        elif event["action"] == "clock-out":
            clock_out_event = event

    last_event = ordered[-1] if ordered else None
    clocked_in = last_event is not None and last_event["action"] == "clock-in"
    duration_minutes = 0
    if clock_in_event:
        start_time = datetime.fromisoformat(clock_in_event["timestamp"])
        end_time = (
            datetime.now().astimezone()
            if clocked_in
            else datetime.fromisoformat(clock_out_event["timestamp"])
            if clock_out_event
            else start_time
        )
        duration_minutes = max(
            0, int((end_time - start_time).total_seconds() // 60)
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
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if gray.shape[1] > MAX_PROCESSING_WIDTH:
        scale = MAX_PROCESSING_WIDTH / gray.shape[1]
        gray = cv2.resize(
            gray,
            (MAX_PROCESSING_WIDTH, round(gray.shape[0] * scale)),
            interpolation=cv2.INTER_AREA,
        )
    return gray


def load_recognizer(model_data):
    path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".yml", delete=False
        ) as model_file:
            model_file.write(model_data)
            path = model_file.name
        recognizer = cv2.face.LBPHFaceRecognizer_create()
        recognizer.read(path)
        return recognizer
    except (OSError, cv2.error) as error:
        raise HTTPException(
            status_code=500, detail="Could not load your registered face model."
        ) from error
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


def serialize_recognizer(recognizer):
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".yml", delete=False) as model_file:
            path = model_file.name
        recognizer.write(path)
        with open(path, encoding="utf-8") as model_file:
            return model_file.read()
    except (OSError, cv2.error) as error:
        raise HTTPException(
            status_code=500, detail="Could not save your registered face model."
        ) from error
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


@app.get("/health")
def health():
    try:
        get_cascades()
        require_supabase_config()
    except RuntimeError as error:
        raise HTTPException(
            status_code=503, detail=f"OpenCV face-recognition setup failed: {error}"
        ) from error
    return {"status": "ok"}


@app.get("/api/status")
def status(authorization: str | None = Header(default=None)):
    current_user = authenticate(authorization)
    profile = get_profile(current_user)
    metadata = current_user.get("user_metadata") or {}
    events = get_events(current_user)
    summary = attendance_summary(events)
    return {
        "registered": bool(profile and profile.get("face_model")),
        "name": profile["full_name"] if profile else metadata.get("full_name"),
        "employee_id": profile["employee_id"] if profile else metadata.get("employee_id"),
        "email": current_user["email"],
        "events": events[:10],
        **summary,
    }


@app.post("/api/register/start")
def start_registration(request: RegisterStart, authorization: str | None = Header(default=None)):
    user = authenticate(authorization)
    name = request.name.strip()
    employee_id = request.employee_id.strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="Enter a name between 1 and 100 characters.")
    if not employee_id or len(employee_id) > 64:
        raise HTTPException(status_code=400, detail="Enter a valid employee ID.")
    with state_lock:
        registrations[user["id"]] = {
            "name": name,
            "employee_id": employee_id,
            "samples": [],
        }
    return {"status": "capturing", "required": REGISTRATION_SAMPLES, "collected": 0}


@app.post("/api/register/frame")
def register_frame(request: ImageFrame, authorization: str | None = Header(default=None)):
    user = authenticate(authorization)
    gray = decode_frame(request.image)
    faces, _ = get_cascades()
    detected = detect_faces(gray, faces)
    if len(detected) == 0:
        return {"status": "face_not_found"}
    if len(detected) > 1:
        return {"status": "multiple_faces"}

    face = normalized_face(gray, tuple(int(value) for value in detected[0]))
    with state_lock:
        registration = registrations.get(user["id"])
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

        recognizer = cv2.face.LBPHFaceRecognizer_create()
        recognizer.train(
            registration["samples"],
            np.zeros(REGISTRATION_SAMPLES, dtype=np.int32),
        )
        model_data = serialize_recognizer(recognizer)
        supabase_request(
            "POST",
            "/rest/v1/employee_profiles",
            user=user,
            params={"on_conflict": "user_id"},
            payload={
                "user_id": user["id"],
                "employee_id": registration["employee_id"],
                "full_name": registration["name"],
                "face_model": model_data,
            },
            prefer="resolution=merge-duplicates,return=representation",
        )
        name = registration["name"]
        registrations.pop(user["id"], None)

    return {"status": "registered", "name": name, "collected": collected}


@app.post("/api/register/cancel")
def cancel_registration(authorization: str | None = Header(default=None)):
    user = authenticate(authorization)
    with state_lock:
        registrations.pop(user["id"], None)
    return {"status": "cancelled"}


@app.post("/api/attendance/start")
def start_attendance(
    request: AttendanceStart, authorization: str | None = Header(default=None)
):
    user = authenticate(authorization)
    profile = get_profile(user, include_model=True)
    if not profile or not profile.get("face_model"):
        raise HTTPException(
            status_code=409, detail="Register your face before recording attendance."
        )
    events = get_events(user)
    summary = attendance_summary(events)
    if request.action == "clock-in" and summary["clocked_in"]:
        raise HTTPException(
            status_code=409,
            detail=f"Already clocked in at {summary['clock_in_time']}. Clock out first.",
        )
    if request.action == "clock-out" and not summary["clocked_in"]:
        raise HTTPException(status_code=409, detail="Clock in before trying to clock out.")
    session_id = str(uuid.uuid4())
    with state_lock:
        attendance_sessions[session_id] = {
            "user_id": user["id"],
            "token": user["token"],
            "action": request.action,
            "name": profile["full_name"],
            "recognizer": load_recognizer(profile["face_model"]),
            "open_seen": False,
            "closed_frames": 0,
        }
    return {"session_id": session_id, "name": profile["full_name"], "status": "waiting_for_face"}


@app.post("/api/attendance/frame")
def attendance_frame(
    request: AttendanceFrame, authorization: str | None = Header(default=None)
):
    user = authenticate(authorization)
    gray = decode_frame(request.image)
    faces, eyes = get_cascades()
    with state_lock:
        session = attendance_sessions.get(request.session_id)
        if session is None or session["user_id"] != user["id"]:
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
        supabase_request(
            "POST",
            "/rest/v1/attendance_events",
            user={"id": user["id"], "token": session["token"]},
            payload={
                "user_id": user["id"],
                "name": session["name"],
                "action": session["action"],
                "timestamp": timestamp,
            },
            prefer="return=minimal",
        )
        attendance_sessions.pop(request.session_id)
        return {
            "status": "recorded",
            "message": f"{session['action']} recorded for {session['name']}.",
            "name": session["name"],
            "action": session["action"],
            "timestamp": timestamp,
        }


@app.post("/api/attendance/cancel")
def cancel_attendance(
    request: SessionRequest, authorization: str | None = Header(default=None)
):
    user = authenticate(authorization)
    with state_lock:
        session = attendance_sessions.get(request.session_id)
        if session and session["user_id"] == user["id"]:
            attendance_sessions.pop(request.session_id, None)
    return {"status": "cancelled"}
