#!/usr/bin/env bash
# Deploy from this machine to EC2: sync code, migrate, build frontend, restart services.
# Usage:
#   export EC2_HOST=18.61.53.174
#   export EC2_KEY=~/Downloads/my-website-key.pem
#   ./scripts/deploy-ec2.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EC2_HOST="${EC2_HOST:-18.61.53.174}"
EC2_USER="${EC2_USER:-ec2-user}"
EC2_KEY="${EC2_KEY:-$HOME/Downloads/my-website-key.pem}"
REMOTE="${EC2_USER}@${EC2_HOST}"

if [[ ! -f "$EC2_KEY" ]]; then
  echo "Missing SSH key: $EC2_KEY" >&2
  exit 1
fi

chmod 600 "$EC2_KEY" 2>/dev/null || true

SSH=(ssh -i "$EC2_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
RSYNC=(rsync -avz -e "ssh -i $EC2_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20")

echo "==> Syncing $ROOT -> $REMOTE:~/arena/"
"${RSYNC[@]}" \
  --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.venv/' \
  --exclude '.next/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.production.local' \
  --exclude 'backend/.env' \
  --exclude 'frontend/.env.production.local' \
  --exclude 'frontend/tsconfig.tsbuildinfo' \
  --exclude 'media/' \
  "$ROOT/" "$REMOTE:~/arena/"

echo "==> Backend migrate + static; frontend build; restart services"
"${SSH[@]}" "$REMOTE" bash -s << 'REMOTE'
set -euo pipefail
cd ~/arena/backend
source .venv/bin/activate
pip install -q -r requirements.txt daphne
python manage.py migrate --noinput
python manage.py collectstatic --noinput

cd ~/arena/frontend
npm ci
npm run build

sudo systemctl restart arena-daphne arena-celery-exec arena-celery-events arena-next nginx
sudo systemctl --no-pager is-active arena-daphne arena-next nginx
REMOTE

echo "==> Done. Open http://${EC2_HOST}/"
