# OpenCV face attendance demo

A local-only face attendance demo with a React Native Expo app and a Python
OpenCV API. It supports one registered face, and requires a matching face and
blink before clock-in or clock-out is written to a CSV file.

## Requirements

- Python 3.9 or newer
- A webcam
- Camera permission for your terminal or Python application

Install the Python dependencies:

```bash
python -m pip install -r requirements.txt
```

`opencv-contrib-python` is pinned to a release that includes the Haar cascade
files used for face and eye detection. LBPH is part of OpenCV's contrib
modules. Do not install `opencv-python` alongside it in the same environment.

## Deploy the API to Render

This demo can be deployed on Render. The face model, profile, and CSV are stored
on a Render persistent disk. The persistent disk requires a paid Render web
service plan. The API is publicly accessible without authentication; anyone
who knows the service URL can register a replacement face or access attendance
records. Only use it with test data you are comfortable exposing.

1. Push this project to a Git provider that Render can access.
2. In Render, choose **New → Blueprint**, select the repository, and deploy
   `render.yaml` from the project root.
3. After the service is live, copy its HTTPS URL, such as
   `https://face-attendance-api.onrender.com`.
4. In the Expo app, enter that URL and tap **Connect**.

The app sends camera images to the deployed service for recognition. The
registered face model, profile, and attendance CSV are stored on its persistent
disk. There is no API access control; do not use real or sensitive data or
distribute this configuration for production use.

## Run the API locally

Start the API locally:

```bash
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

On a physical phone, use
`http://<your-computer-LAN-IP>:8000`; on Android emulator use
`http://10.0.2.2:8000`; on iOS simulator use `http://127.0.0.1:8000`.
For a physical phone, confirm the URL loads from the phone's browser, use the
computer's Wi-Fi IP (not `127.0.0.1`), and check that the computer firewall
allows port 8000.

## Start the Expo app

```bash
cd mobile
npm install
npm start
```

Open the app using Expo Go on a phone or an iOS/Android simulator. The Render
API URL is prefilled; open **Server settings** if you need to change it.

Tap **Connect**, allow camera permission, then register a face. Registration
captures 5 samples, taking a few seconds; look at the camera and move your
head slightly. When clocking in or out, look at the camera and blink after the
app detects a face match. The app displays the recorded time, disables the
completed action, enables the next action, and shows the shift duration.

The Expo app is written in plain JavaScript (`App.jsx`), not TypeScript. The
older command-line interface remains available:

## Register one person from the command line

```bash
python attendance.py register --name "Test User"
```

Face the camera and move your head slightly while the app collects 5 samples.
Press `q` to cancel. A new registration replaces the existing single-person
profile.

## Record attendance

```bash
python attendance.py attendance --action clock-in
python attendance.py attendance --action clock-out
```

The app waits for one matching face and a blink. A different face shows
`Face not matched` and does not create an attendance record. Press `q` to
cancel. If the camera is not the default camera, pass `--camera 1` (or another
camera index).

The LBPH confidence threshold defaults to `70`; lower values are stricter.
Adjust it with `--threshold`, for example:

```bash
python attendance.py attendance --action clock-in --threshold 60
```

## Local files

- `face_data/face_model.yml` — registered face model
- `face_data/profile.json` — registered name
- `face_data/attendance.csv` — clock-in/clock-out events and local timestamps

No database is used. Keep the face model, profile, and attendance records
private, and remove them when finished testing.
This is a basic demo, not a production-grade identity or anti-spoofing system:
Haar cascade eye detection can miss blinks or mistake eye occlusion for a blink,
and a blink alone does not reliably prevent presentation attacks. Test under
your camera and lighting conditions before relying on its results.
