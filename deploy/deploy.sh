#!/usr/bin/env bash
# Update TravelMate on the server from GitHub main.
# Usage (as deploy):  ~/travelmate/deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"

# 1. Backup the database before changing anything (skipped on the very first run)
if $COMPOSE ps --status running --services 2>/dev/null | grep -qx db; then
  ./deploy/backup.sh
fi

# 2. Get the latest code (fails if someone edited files on the server)
git fetch origin main
git merge --ff-only origin/main
echo "Deploying $(git log -1 --format='%h %s')"

# 3. Rebuild and restart only what changed
$COMPOSE up -d --build
$COMPOSE ps
docker image prune -f >/dev/null
