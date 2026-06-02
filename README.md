# Arena

Real-time coding battle platform with:
- **Frontend:** Next.js (`frontend`)
- **Backend API + WebSockets:** Django + Channels (`backend`)
- **Async workers:** Celery
- **Broker / channel layer:** Redis

---

## Project Structure

- `frontend` - Next.js app (battle UI, spectate UI, auth flows)
- `backend` - Django REST API, Channels consumers, Celery tasks
- `problems` - Problem dataset and related assets

---

## Prerequisites

- Python 3.12+ (project currently runs on 3.14 as well)
- Node.js 18+ and npm
- Redis running on `127.0.0.1:6379`
- MySQL (or matching DB settings in `backend/config/settings.py`)
- Clerk keys for frontend auth

---

## One-Time Setup

### 1) Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 manage.py migrate
```

To import the full problem set into DB (supports `problems/merged_problems.json`):

```bash
python3 manage.py import_problems ../problems/merged_problems.json
```

If needed, create and update backend env vars:

```bash
cp ../.env.example .env
```

### 2) Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local` with at least:

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_WS_BASE_URL=ws://127.0.0.1:8000
# plus NEXT_PUBLIC_CLERK_* values
```

---

## Run Locally (4 Terminals)

### Terminal A - Backend API + WebSockets

```bash
cd backend
source .venv/bin/activate
daphne -b 127.0.0.1 -p 8000 config.asgi:application
```

### Terminal B - Celery Worker

```bash
cd backend
source .venv/bin/activate
celery -A config worker -l info -Q execution,events --without-heartbeat
```

### Terminal C - Redis

```bash
redis-server
```

### Terminal D - Frontend

```bash
cd frontend
npm run dev -- --hostname 0.0.0.0 --port 3000
```

Open: `http://localhost:3000`

---

## Quick Health Checks

- Backend API:
  ```bash
  curl -I http://127.0.0.1:8000/api/problems/
  ```
- Frontend:
  - Visit `http://localhost:3000`
- Redis:
  ```bash
  redis-cli ping
  ```
  Expect `PONG`.

---

## Common Issues

- **`Address already in use` (8000/3000/6379):**
  Another process is already running on that port. Stop it first.

- **Spectate/live updates not working:**
  Ensure you are running **Daphne** (ASGI), not only `runserver`.

- **`Could not connect to Redis at 127.0.0.1:6379`:**
  Start Redis in another terminal.

- **`Unknown or unexpected option: --host` (Next.js):**
  Use `--hostname` instead:
  ```bash
  npm run dev -- --hostname 0.0.0.0 --port 3000
  ```

- **Celery heartbeat errors on macOS:**
  Keep `--without-heartbeat` in the worker command.

- **`mysqlclient` / `pkg-config` errors when `pip install` on macOS:**
  This repo uses **PyMySQL** as the MySQL driver (`pymysql.install_as_MySQLdb()`), so `mysqlclient` is not in `requirements.txt`. If you still have an old checkout, remove the `mysqlclient` line or `git pull` the latest `requirements.txt`.

---

## Notes

- Battles are time-bound; server-side state finalization is handled via API/task flow.
- WebSocket routes are served via Django Channels and Redis channel layer.
- For spectator mode and live typing, all four services should be up.

---

## Deploy Checklist (Recommended)

On a fresh host, run these in order:

```bash
cd backend
source .venv/bin/activate
python manage.py migrate
python manage.py import_problems ../problems/merged_problems.json
```

This ensures schema + full questions dataset are present after deploy.

