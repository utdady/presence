# Presence

Privacy-first, presence-only messaging for a closed hub-and-spoke circle.
Messages exist only while both people are online. The server relays ciphertext
and presence — never plaintext. Join is invite-only: the hub creates invite links; members cannot invite others.
After joining, spokes can only message the hub — never each other.

## Quick start

### Backend

```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
# First time: create your real roster (gitignored)
copy users.example.json users.json   # Windows
# cp users.example.json users.json   # macOS/Linux
# Then edit users.json — replace placeholder hashes (see "Add a user")
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

### Production preview (local)

Build the SPA, then let FastAPI serve it (same shape as Fly):

```bash
cd frontend
npm run build

cd ../backend
# Windows PowerShell:
$env:CORS_ORIGINS="*"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000 — API, WebSocket, and UI share one origin.

Or keep the API on `:8000` and preview the built assets with Vite’s proxy:

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

### Deploy free on Fly.io

1. Install the [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/) and sign up (`fly auth login`).
2. Edit [`fly.toml`](fly.toml): set `app = 'presence-YOURNAME'` to a unique name.
3. From the **repo root**:

```bash
fly apps create presence-YOURNAME   # skip if create already ran / name taken
fly secrets set JWT_SECRET="paste-a-long-random-string-here"
# Real roster is NOT in git. Push it as a secret (reads stdin):
#   macOS/Linux:  fly secrets set USERS_JSON=- < backend/users.json
#   PowerShell:   Get-Content -Raw backend/users.json | fly secrets set USERS_JSON=-
fly deploy
```

4. Open `https://presence-YOURNAME.fly.dev`, sign in, install as PWA on your phone.

`backend/users.json` is gitignored. Only `backend/users.example.json` is
committed (placeholder hub/alice/dummy accounts). Keep plaintext passwords in
`credentials.local.json` (also gitignored) and share them out of band. On Fly,
invite signups persist on a **volume** (`/data/users.json`). `USERS_JSON` only
seeds an empty volume — it does not overwrite existing users on deploy. After
changing the seed roster locally, update the secret once:

```powershell
Get-Content -Raw backend/users.json | fly secrets set USERS_JSON=-
```

(Only needed for a fresh volume; day-to-day invites save themselves.)

### Android auto-updates

- **Web UI:** the Capacitor app loads `https://presence-addy.fly.dev`, so `fly deploy`
  updates sign-in, chat UI, and settings without reinstalling.
- **Native Bluetooth plugin:** still needs a new APK. GitHub Actions builds
  `presence-debug.apk` on every `main` push and publishes it under
  [Releases](https://github.com/utdady/presence/releases/latest). Settings →
  **Get latest Android APK**, or:

```bash
cd frontend
npm run apk:debug
```

Rebuild after UI/native changes with the same `npm run apk:debug` command.
**Bluetooth Nearby only works in this APK** — deploying the website alone is not enough
for the native plugin, but web UI updates apply automatically via the live URL.

### Test dummy bot

A Python spoke client that stays online and replies — useful without juggling two browsers.

```bash
cd bot
pip install -r requirements.txt
# Echo (default) — reverse-ish reply after a short typing pause
BOT_PASSWORD="<dummy-password>" python main.py
# Or Ollama (requires `ollama serve` + a pulled model)
BOT_PASSWORD="<dummy-password>" python main.py --mode ollama --model llama3.2
```

Log in as `hub` in the browser, open **Dummy**, send a message. Kill the bot process to exercise `peer_offline` / thread clear.

In PowerShell, set the environment variable first:

```powershell
$env:BOT_PASSWORD = "<dummy-password>"
python main.py
```

Identity key is stored at `bot/identity_key.json` (gitignored). Dev fixture only — do not use for real friends.

## Invites (hub only)

1. Sign in as the **hub** account.
2. Open **Invites** → **Create invite link** (copied to clipboard).
3. Send the link out of band (`https://your-host/?invite=…`).
4. Friend opens the link, sets username/password, joins.
5. They only see you in Friends; they cannot discover or message other members.

Invites are stored in `backend/invites.json` (gitignored). New accounts are
appended to `backend/users.json`. On Fly, the users file must be writable
(volume or local disk) — a read-only `USERS_JSON` secret alone will not persist
signups across restarts.

## Add a user

1. Hash a password:

```bash
cd backend
python hash_password.py "their-password"
```

2. Append to `backend/users.json`:

```json
{
  "id": "daniel",
  "username": "daniel",
  "display_name": "Daniel",
  "password_hash": "<paste hash>",
  "role": "spoke",
  "avatar_color": "#6F7A8B"
}
```

3. Restart the backend (or redeploy). For Fly, refresh the secret first:

```powershell
Get-Content -Raw backend/users.json | fly secrets set USERS_JSON=-
fly deploy
```

Hand the username/password to them out of band.

Keep exactly one user with `"role": "hub"`.

## Architecture notes

- **Auth:** Argon2id password verify → JWT → WebSocket `?token=`
- **Graph:** hub ↔ spoke only; spoke ↔ spoke rejected server-side
- **Crypto (client):** X25519 identity keys in IndexedDB, session key via ECDH + BLAKE2b, ChaCha20-Poly1305 AEAD for msg/typing/reaction payloads
- **State:** connections and public keys in RAM only; the user roster is loaded from `USERS_JSON` (preferred) or local `users.json` at boot — never from the public git tree

## Verification checklist

- Log in as two spoke users in separate browsers — neither can see or message the other
- Hub sees both spokes; messaging works only when the peer is online
- Send while peer offline → ack `undelivered`, no queue
- Peer disconnect clears the live thread after a short transition
- Run `python bot/main.py`, chat with Dummy from hub, then Ctrl+C the bot to see offline transition


## Nearby (Bluetooth-only on Android)

Offline 1:1 **encrypted chat and voice** between two Presence Android devices that
are physically nearby. Discovery and all data use **Google Nearby Connections
over Bluetooth** — **no Wi‑Fi and no internet** are required for the Nearby
session (sign in once beforehand so identity keys exist). Cellular and Wi‑Fi can
stay off; keep **Bluetooth** on and grant location / Nearby permissions if asked.

Voice is sent as short encrypted audio chunks over the same Nearby payload channel
(talkie-quality latency). Chat uses the same encrypted session.

On **web / PC / iPhone browser**, peer Bluetooth is not available. The Nearby
screen shows an install CTA for the Android APK. Optional **online rooms**
(room codes) still exist as a fallback: they need the Presence server on the
internet for signaling and are **not** offline Bluetooth.

### Build a sideloadable APK (no Play Store)

**One-time toolchain** (downloads Temurin JDK 21 + Android SDK into gitignored `tools/`):

```bash
cd frontend
npm run apk:setup
```

Then build:

```bash
cd frontend
npm run apk:debug
```

Output: `releases/presence-debug.apk` (~5 MB debug build).

**Install on a phone**

1. Copy `presence-debug.apk` to the phone (USB, Drive, AirDrop-from-PC, etc.).
2. Open the file → Allow “Install unknown apps” for that source if prompted.
3. Install → open **Presence**.

Or with USB debugging:

```bash
adb install -r releases/presence-debug.apk
```

Rebuild after UI/native changes with the same `npm run apk:debug` command.
**Bluetooth Nearby only works in this APK** — deploying the website alone is not enough.

### Build the Android app (Android Studio)

Requirements: JDK 21+, Android SDK (or Android Studio). This repo can use a portable toolchain under `tools/` (gitignored). An Android device/emulator with Google
Play services (Nearby Connections).

```bash
cd frontend
npm install
npm run cap:android
```

Or step by step:

```bash
cd frontend
npm run build
npx cap sync android
npx cap open android
```

In Android Studio, run on two physical devices (emulators often lack reliable
Nearby/Bluetooth).

Local plugin: `frontend/plugins/presence-nearby` (Capacitor `PresenceNearby`).

### In-app flow (Android)

1. Sign in on both devices (online once is enough for keys; Nearby itself does
   not need the hub or internet after that).
2. Open **Nearby** → **Find nearby**; grant Bluetooth / location / mic if asked.
3. Tap the other device, wait for key exchange (fingerprint shown).
4. Chat in the panel, and/or **Call** / **Accept**. Use Mute / End as needed.
5. Optional: airplane mode with Bluetooth still on — chat and call should keep working.

### Verification checklist

- [ ] Two Android builds discover each other with airplane mode on and Wi‑Fi off (Bluetooth on)
- [ ] Chat works both ways while connected without internet
- [ ] Outgoing and incoming call both connect with audible audio over Bluetooth payloads
- [ ] Mute stops sending local audio; End returns both sides to ready/scanning
- [ ] Decline rejects an incoming call
- [ ] Online hub chat still works in the same app when the network is back
- [ ] Web/PWA Nearby screen shows the Android-app CTA (does not silently fail)

### Not in v1

Nearby photos, voice notes, video calls, iOS Multipeer, and mesh hops.
