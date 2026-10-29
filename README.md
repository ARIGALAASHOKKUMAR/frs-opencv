# APFD face attendance

A React Native Expo app and Python FastAPI service for employee accounts,
single-face registration, and blink-confirmed clock-in/out. Supabase provides
email/password authentication and stores each employee profile, face model, and
attendance events. OpenCV performs face matching in the API.

## Configure Supabase

1. In Supabase, open **SQL Editor**, paste and run [`supabase/schema.sql`](./supabase/schema.sql).
   The tables use row-level security so a signed-in employee can access only
   their own profile and attendance records.
2. In **Authentication → Providers**, enable Email. Supabase email confirmation
   may be left on; employees then need to confirm their address before signing
   in. For local testing only, email confirmation can be disabled in the Auth
   settings.
3. Use the project's **publishable** key in the app and API. Do not use the
   PostgreSQL connection string or a service-role/secret key.

The face model is biometric data. This demo stores it in the employee's
row-protected `employee_profiles.face_model` column. Use test data and restrict
access to your Supabase project.

## Configure the Expo app

```bash
cd mobile
cp .env.example .env
```

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in
`mobile/.env` to the Supabase project URL and publishable key. This file is
git-ignored. Restart Expo after changing environment variables:

```bash
npm install
npm start
```

The sign-up form creates an account with full name, employee ID, email, and
password. Passwords are handled only by Supabase Auth. After signing in, open
**Profile → Register Face** and follow the camera instructions. Each account
has its own face model and attendance history.

This learning setup allows public self-registration; it does not check the
employee ID against an official staff list or require an administrator invite.
Do not treat an account or face match as proof of employment.
Existing local CSV attendance and face files are not automatically imported;
new accounts must enroll their face again.

## Deploy the API to Render

Deploy the repository using the included `render.yaml` Blueprint. In the
Render service's environment settings, add:

- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` — your Supabase publishable key

The Blueprint preconfigures the project URL and prompts for the publishable
key. Never add a PostgreSQL password, service-role key, or other secret to the
Expo app, source control, or a public setting.

In the Expo app, the default attendance API is
`https://frs-opencv.onrender.com`; change it under **Profile → Settings** if
your Render URL is different. The API accepts only valid Supabase access
tokens. It uses each employee's token for database requests, and Supabase RLS
enforces user ownership without a service-role key.

## Run the API locally

Set the same two Supabase environment variables in the terminal, then run:

```bash
python -m pip install -r requirements.txt
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

For a physical phone, set the API URL in **Profile → Settings** to
`http://<your-computer-LAN-IP>:8000`. Ensure the phone and computer share a
network and the computer firewall allows port 8000. Android emulator uses
`http://10.0.2.2:8000`; iOS simulator uses `http://127.0.0.1:8000`.

## Attendance and face registration

Registration captures 5 samples. Clock-in/out requires a matching face and an
open-eye → closed-eye → open-eye blink sequence. Temporary camera frames are
processed by the API and are not stored. The final face model and attendance
event are stored in Supabase; the API scales larger images down before face
detection.

This is a learning demo, not a production-grade identity or anti-spoofing
system. Haar eye detection can miss blinks or mistake eye occlusion for a blink,
and a blink alone does not reliably prevent presentation attacks. Review
privacy, consent, employee access, and retention requirements before real use.
