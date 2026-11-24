#!/usr/bin/env bash
# Daily Postgres dump for TravelMate. Keeps the last 14 dumps.
# Cron (as deploy):  15 3 * * * /home/deploy/travelmate/deploy/backup.sh >> /home/deploy/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=/home/deploy/backups
mkdir -p "$DEST"
umask 077
FILE="$DEST/travelmate-$(date +%F-%H%M).dump"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U travelmate -d travelmate -Fc > "$FILE"
find "$DEST" -name 'travelmate-*.dump' -mtime +14 -delete
echo "$(date -Is) ok $FILE $(du -h "$FILE" | cut -f1)"
