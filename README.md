# Bigoff – Real-time DSA Battle Platform

Bigoff is a full-stack arena for real-time DSA battles with HP-based combat, sabotage moves, and live spectators.

## Stack

- **Backend**: Django 5 + Django REST Framework + Django Channels (Redis)
- **Database**: MySQL
- **Frontend**: Next.js 14 (App Router) + Tailwind CSS + Monaco editor

## Project layout

- `backend/` – Django project (`config`) and apps: `accounts`, `problems`, `battles`, `sabotage`, `spectators`, `dashboard`
- `frontend/` – Next.js 14 app with noir terminal UI and battle views

## Arena — local dev setup

### System dependencies (one-time, macOS)
```bash
brew install mysql-client pkg-config redis
export PKG_CONFIG_PATH="/opt/homebrew/opt/mysql-client/lib/pkgconfig"
```

### Services — start before anything else

Open DBngin and start both:
- MySQL 8 — `bigofff` on port 3306
- Redis — port 6379

### Backend setup (one-time)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
export PKG_CONFIG_PATH="/opt/homebrew/opt/mysql-client/lib/pkgconfig"
pip install -r requirements.txt
pip install svix
python3 manage.py migrate
python3 manage.py seed_problems
```

### Run (4 terminals, all from backend/ with venv active)
```bash
# Terminal 1
source .venv/bin/activate
daphne -p 8000 config.asgi:application

# Terminal 2
source .venv/bin/activate
celery -A config worker -Q execution -c 4 --loglevel=info

# Terminal 3
source .venv/bin/activate
celery -A config worker -Q events -c 10 --loglevel=info

# Terminal 4
cd ../frontend && npm install && npm run dev
```

Open `http://localhost:3000`

### Adding problems to the bank
```bash
python3 manage.py import_problems path/to/problems.json
```

JSON format:
```json
[
  {
    "title": "Problem Title",
    "difficulty": "easy|medium|hard",
    "description": "...",
    "input_format": "...",
    "output_format": "...",
    "constraints": "...",
    "sample_input": "...",
    "sample_output": "...",
    "test_cases": [
      {"input": "...", "output": "..."}
    ]
  }
]
```

### Environment variables

Backend `.env`:
```
DJANGO_SECRET_KEY=any-random-string-for-local-dev
DJANGO_DEBUG=True
REDIS_URL=redis://127.0.0.1:6379/0
CLERK_WEBHOOK_SECRET=from-clerk-dashboard
```

Frontend `.env.local`:
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8000
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=from-clerk-dashboard
CLERK_SECRET_KEY=from-clerk-dashboard
```

## Key URLs

- Landing: `http://localhost:3000/`
- Register / Login: `/register`, `/login`
- Lobby: `/lobby`
- Battle: `/battle/:id`
- Spectate: `/spectate/:id`
- Profile: `/profile/:username`
- Admin dashboard: `/admin` (admin / superadmin only) 