#!/usr/bin/env bash
# Restore a full pg_dump backup using pg_restore from inside the Docker container.
# No local pg_restore required.
# Usage: ./scripts/import.sh path/to/backup.dump
set -euo pipefail

cd "$(dirname "$0")/.."

DUMP_FILE="${1:-}"
if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage: $0 <backup.dump>"
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "File not found: $DUMP_FILE"
  exit 1
fi

if ! docker compose ps db --status running 2>/dev/null | grep -q db; then
  echo "Postgres container is not running. Start it with: docker compose up -d db"
  exit 1
fi

echo "Restoring from $DUMP_FILE…"
echo "This will REPLACE all data in the current database."
read -r -p "Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# Pipe dump file into pg_restore in container
docker compose exec -T db pg_restore --clean --if-exists --no-owner -U finance -d finance < "$DUMP_FILE"
echo "Done."
