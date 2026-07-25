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
fly deploy
```

4. Open `https://presence-YOURNAME.fly.dev`, sign in, install as PWA on your phone.

Change seed passwords in `backend/users.json` (and rebuild/redeploy) before sharing with friends. The free tier may stop machines when idle — first load can be slow; presence requires the machine running.

### Seed accounts (change these passwords)

| Username | Password (dev) | Role  |
|----------|----------------|-------|
| hub      | hub-pass-change-me | hub |
| alice    | alice-pass-change-me | spoke |
| bob      | bob-pass-change-me | spoke |
| dummy    | dummy-pass-change-me | spoke (test bot) |

### Test dummy bot

A Python spoke client that stays online and replies — useful without juggling two browsers.

```bash
cd bot
pip install -r requirements.txt
# Echo (default) — reverse-ish reply after a short typing pause
python main.py
# Or Ollama (requires `ollama serve` + a pulled model)
python main.py --mode ollama --model llama3.2
```

Log in as `hub` in the browser, open **Dummy**, send a message. Kill the bot process to exercise `peer_offline` / thread clear.

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

3. Restart the backend (or rely on process restart). Hand the username/password to them out of band.

Keep exactly one user with `"role": "hub"`.

## Architecture notes

- **Auth:** Argon2id password verify → JWT → WebSocket `?token=`
- **Graph:** hub ↔ spoke only; spoke ↔ spoke rejected server-side
- **Crypto (client):** X25519 identity keys in IndexedDB, session key via ECDH + BLAKE2b, ChaCha20-Poly1305 AEAD for msg/typing/reaction payloads
- **State:** connections and public keys in RAM only; `users.json` is the only durable store

## Verification checklist

- Log in as `alice` and `bob` in two browsers — neither can see or message the other
- Hub sees both; messaging works only when the peer is online
- Send while peer offline → ack `undelivered`, no queue
- Peer disconnect clears the live thread after a short transition
- Run `python bot/main.py`, chat with Dummy from hub, then Ctrl+C the bot to see offline transition
