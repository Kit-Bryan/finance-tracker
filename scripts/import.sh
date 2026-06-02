#!/usr/bin/env bash
# Restore a full pg_dump backup into this app's Postgres
# Usage: ./scripts/import.sh path/to/backup.dump
set -euo pipefail

DUMP_FILE="${1:-}"
if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage: $0 <backup.dump>"
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "File not found: $DUMP_FILE"
  exit 1
fi

source .env.local 2>/dev/null || true
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"

echo "Restoring from $DUMP_FILE into $DATABASE_URL..."
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP_FILE"
echo "Done."
