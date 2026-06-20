#!/usr/bin/env sh
set -eu

BACKUP_ROOT="${BACKUP_ROOT:-$PWD/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-snmp-monitor-postgres}"
POSTGRES_USER="${POSTGRES_USER:-snmp}"
POSTGRES_DB="${POSTGRES_DB:-snmp_monitor}"

mkdir -p "$BACKUP_DIR"

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  COMPOSE="docker compose"
fi

echo "Backup directory: $BACKUP_DIR"
echo "Checking containers..."
$COMPOSE ps > "$BACKUP_DIR/compose-ps.txt"

if [ -f .env ]; then
  cp .env "$BACKUP_DIR/env.backup"
fi

if [ -f docker-compose.yml ]; then
  cp docker-compose.yml "$BACKUP_DIR/docker-compose.yml.backup"
fi

echo "Dumping PostgreSQL database..."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6 > "$BACKUP_DIR/${POSTGRES_DB}.dump"

echo "Recording versions..."
{
  git describe --tags --always 2>/dev/null || true
  git rev-parse HEAD 2>/dev/null || true
  docker --version
  $COMPOSE version
} > "$BACKUP_DIR/versions.txt"

echo "Backup completed: $BACKUP_DIR"
