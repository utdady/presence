# Presence

Privacy-first, presence-only messaging for a closed hub-and-spoke circle.
Messages exist only while both people are online. The server relays ciphertext
and presence — never plaintext. There is no registration: you seed accounts and
hand credentials to friends. Spokes can only talk to the hub.

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
`credentials.local.json` (also gitignored) and share them out of band. After
changing users, update the Fly secret and redeploy (or at least reset the
secret — the app reloads users on boot). The free tier may stop machines when
idle — first load can be slow; presence requires the machine running.

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
