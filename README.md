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

`opencv-contrib-python` is required because the LBPH recognizer is part of
OpenCV's contrib modules. Do not install `opencv-python` alongside it in the
same environment.

## Deploy the API to Render

This demo can be deployed as a private-use service on Render. The API requires
a bearer token, and the face model, profile, and CSV are stored on a Render
persistent disk. The persistent disk requires a paid Render web service plan.
Do not use this sample as a public or production attendance system.

1. Push this project to a Git provider that Render can access.
2. In Render, choose **New → Blueprint**, select the repository, and deploy
   `render.yaml` from the project root.
3. Generate a long random token locally:

   ```bash
   python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
   ```

4. Enter that token as `API_ACCESS_TOKEN` when Render asks for the unsynced
   secret. Keep it private.
5. After the service is live, copy its HTTPS URL, such as
   `https://face-attendance-api.onrender.com`.
6. In the Expo app, enter that URL and the exact `API_ACCESS_TOKEN` you
   configured in Render, then tap **Connect**.

The app sends camera images to the deployed service for recognition. The
registered face model, profile, and attendance CSV are stored on its persistent
disk. The bearer token protects API endpoints but is a shared secret suitable
only for this private test app; do not distribute the app or token publicly.

## Run the API locally

The API also requires a token when running locally. In one terminal, generate
a token and set it before starting the API:

```bash
export API_ACCESS_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

Enter the same token in the Expo app. On a physical phone, use
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

Open the app using Expo Go on a phone or an iOS/Android simulator and enter
the Render HTTPS URL and API access token.

Tap **Connect**, allow camera permission, then register a face. Keep your face
in the preview and move your head slightly while the app collects 30 samples.
Choose **Clock in** or **Clock out**, look at the camera, and blink when the
app indicates a face match.

The Expo app is written in plain JavaScript (`App.jsx`), not TypeScript. The
older command-line interface remains available:

## Register one person from the command line

```bash
python attendance.py register --name "Test User"
```

Face the camera and move your head slightly while the app collects samples.
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

No database is used. Keep the API token private, and remove the face model,
profile, and attendance records when finished testing.
This is a basic demo, not a production-grade identity or anti-spoofing system:
Haar cascade eye detection can miss blinks or mistake eye occlusion for a blink,
and a blink alone does not reliably prevent presentation attacks. Test under
your camera and lighting conditions before relying on its results.
