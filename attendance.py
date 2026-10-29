#!/usr/bin/env python3
"""Single-person face registration and blink-confirmed attendance using OpenCV."""

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np


DATA_DIR = Path(
    os.environ.get("FACE_DATA_DIR", Path(__file__).resolve().parent / "face_data")
).expanduser()
MODEL_PATH = DATA_DIR / "face_model.yml"
PROFILE_PATH = DATA_DIR / "profile.json"
ATTENDANCE_PATH = DATA_DIR / "attendance.csv"
FACE_CASCADE_PATH = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
EYE_CASCADE_PATH = cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml"
FACE_SIZE = (200, 200)
REGISTRATION_SAMPLES = 30


def load_cascades():
    face_cascade = cv2.CascadeClassifier(FACE_CASCADE_PATH)
    eye_cascade = cv2.CascadeClassifier(EYE_CASCADE_PATH)
    if face_cascade.empty() or eye_cascade.empty():
        raise RuntimeError("Could not load OpenCV face/eye detection cascades.")
    if not hasattr(cv2, "face") or not hasattr(cv2.face, "LBPHFaceRecognizer_create"):
        raise RuntimeError(
            "LBPH face recognition is unavailable. Install opencv-contrib-python "
            "(not opencv-python) using: python -m pip install -r requirements.txt"
        )
    return face_cascade, eye_cascade


def open_camera(camera_index):
    camera = cv2.VideoCapture(camera_index)
    if not camera.isOpened():
        camera.release()
        raise RuntimeError(
            f"Could not open camera {camera_index}. Check camera permissions and "
            "the --camera value."
        )
    return camera


def detect_faces(gray, cascade):
    return cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(100, 100)
    )


def normalized_face(gray, rectangle):
    x, y, width, height = rectangle
    face = gray[y : y + height, x : x + width]
    face = cv2.equalizeHist(face)
    return cv2.resize(face, FACE_SIZE)


def register(name, camera_index):
    name = name.strip()
    if not name:
        raise RuntimeError("The registered name cannot be empty.")
    face_cascade, _ = load_cascades()
    camera = open_camera(camera_index)
    samples = []
    frame_number = 0

    print(f"Registering {name}. Look at the camera and move your head slightly.")
    print(f"Capturing {REGISTRATION_SAMPLES} face samples. Press q to cancel.")

    try:
        while len(samples) < REGISTRATION_SAMPLES:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Could not read a frame from the camera.")

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detect_faces(gray, face_cascade)
            message = "Center your face in the camera"

            if len(faces) == 1:
                rectangle = tuple(int(value) for value in faces[0])
                x, y, width, height = rectangle
                cv2.rectangle(frame, (x, y), (x + width, y + height), (0, 200, 0), 2)
                message = f"Samples: {len(samples)}/{REGISTRATION_SAMPLES}"
                if frame_number % 3 == 0:
                    samples.append(normalized_face(gray, rectangle))
            elif len(faces) > 1:
                message = "Only one person should be visible"

            frame_number += 1
            cv2.putText(
                frame, message, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                (0, 200, 0), 2,
            )
            cv2.imshow("Face registration - press q to cancel", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("Registration cancelled.")
                return
    finally:
        camera.release()
        cv2.destroyAllWindows()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    recognizer = cv2.face.LBPHFaceRecognizer_create()
    recognizer.train(samples, np.zeros(len(samples), dtype=np.int32))
    recognizer.write(str(MODEL_PATH))
    PROFILE_PATH.write_text(
        json.dumps({"name": name}, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Registered {name}. Local face model saved in {DATA_DIR}.")


def load_profile():
    if not MODEL_PATH.is_file() or not PROFILE_PATH.is_file():
        raise RuntimeError(
            "No registered face was found. Register one first with: "
            "python attendance.py register --name \"Your Name\""
        )
    try:
        profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        name = profile["name"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("The registered profile has no valid name.")
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
        raise RuntimeError(f"Could not read the registered profile: {error}") from error

    recognizer = cv2.face.LBPHFaceRecognizer_create()
    try:
        recognizer.read(str(MODEL_PATH))
    except cv2.error as error:
        raise RuntimeError(f"Could not read the face model: {error}") from error
    return name, recognizer


def eye_state(gray, face_rectangle, eye_cascade):
    x, y, width, height = face_rectangle
    eye_region = gray[y : y + int(height * 0.6), x : x + width]
    eyes = eye_cascade.detectMultiScale(
        eye_region, scaleFactor=1.1, minNeighbors=4, minSize=(12, 12)
    )
    # Ignore detections below the eye line; Haar eye cascades can detect other details.
    eye_count = sum(1 for _, ey, _, _ in eyes if ey < eye_region.shape[0] * 0.8)
    return eye_count >= 2


def append_attendance(name, action):
    new_file = not ATTENDANCE_PATH.exists()
    ATTENDANCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ATTENDANCE_PATH.open("a", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        if new_file:
            writer.writerow(["timestamp", "name", "action"])
        writer.writerow(
            [datetime.now().astimezone().isoformat(timespec="seconds"), name, action]
        )


def take_attendance(action, camera_index, threshold):
    face_cascade, eye_cascade = load_cascades()
    name, recognizer = load_profile()
    camera = open_camera(camera_index)

    open_seen = False
    closed_frames = 0
    blink_seen = False
    match_frames = 0
    last_status = "Face not matched"

    print(f"Ready for {action} for {name}. Look at the camera, then blink.")
    print("Press q to cancel.")

    try:
        while True:
            ok, frame = camera.read()
            if not ok:
                raise RuntimeError("Could not read a frame from the camera.")

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = detect_faces(gray, face_cascade)
            matching_rectangle = None

            if len(faces) == 1:
                rectangle = tuple(int(value) for value in faces[0])
                prediction, confidence = recognizer.predict(normalized_face(gray, rectangle))
                if prediction == 0 and confidence <= threshold:
                    matching_rectangle = rectangle
                    match_frames += 1
                    x, y, width, height = rectangle
                    cv2.rectangle(frame, (x, y), (x + width, y + height), (0, 200, 0), 2)
                    last_status = f"Face matched ({confidence:.0f}) - blink to confirm"
                else:
                    match_frames = 0
                    open_seen = False
                    closed_frames = 0
                    last_status = "Face not matched"
                    x, y, width, height = rectangle
                    cv2.rectangle(frame, (x, y), (x + width, y + height), (0, 0, 255), 2)
            else:
                match_frames = 0
                open_seen = False
                closed_frames = 0
                if len(faces) > 1:
                    last_status = "Only one person should be visible"
                else:
                    last_status = "Face not found"

            if matching_rectangle is not None and not blink_seen and match_frames >= 3:
                eyes_open = eye_state(gray, matching_rectangle, eye_cascade)
                if eyes_open:
                    if closed_frames >= 2 and open_seen:
                        blink_seen = True
                    open_seen = True
                    closed_frames = 0
                elif open_seen:
                    closed_frames += 1

            if blink_seen:
                append_attendance(name, action)
                print(f"{action} recorded for {name} in {ATTENDANCE_PATH}.")
                break

            cv2.putText(
                frame, last_status, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.65,
                (0, 200, 0) if "matched" in last_status else (0, 0, 255), 2,
            )
            cv2.imshow("Face attendance - press q to cancel", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("Attendance cancelled.")
                break
    finally:
        camera.release()
        cv2.destroyAllWindows()


def parse_args():
    parser = argparse.ArgumentParser(
        description="Register one face and record blink-confirmed attendance."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    register_parser = commands.add_parser("register", help="Register the single user")
    register_parser.add_argument("--name", required=True, help="Name for the profile")
    register_parser.add_argument("--camera", type=int, default=0, help="Camera index")

    attendance_parser = commands.add_parser(
        "attendance", help="Record a clock-in or clock-out"
    )
    attendance_parser.add_argument(
        "--action", choices=("clock-in", "clock-out"), required=True
    )
    attendance_parser.add_argument("--camera", type=int, default=0, help="Camera index")
    attendance_parser.add_argument(
        "--threshold",
        type=float,
        default=70.0,
        help="LBPH match threshold; lower is stricter (default: 70)",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        if args.command == "register":
            register(args.name.strip(), args.camera)
        else:
            take_attendance(args.action, args.camera, args.threshold)
    except (RuntimeError, OSError, cv2.error) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
