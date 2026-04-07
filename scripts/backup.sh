#!/usr/bin/env bash
set -euo pipefail
umask 077  # Backup contains OAuth tokens - restrict file permissions

# --- Constants ---
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$HOME/.journal-backups"
LOG_FILE="$BACKUP_DIR/backup.log"
DB_NAME="private-journal"
NTFY_TOPIC="${NTFY_TOPIC:-}"  # Set via env or leave empty to skip notifications
RETENTION_DAYS=30
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="$BACKUP_DIR/journal-${DATE}.sql"
BACKUP_GZ="$BACKUP_FILE.gz"

# --- Helpers ---
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

notify_failure() {
    [ -z "$NTFY_TOPIC" ] && return 0
    local msg="${1:-Backup failed}"
    curl -sf -H "Title: Journal Backup Failed" -H "Priority: high" \
        -H "Tags: warning" -d "$msg" \
        "https://ntfy.sh/${NTFY_TOPIC}" || true
}

trap 'log "ERROR: Backup failed at line $LINENO"; notify_failure "Journal backup failed at line $LINENO. Check $LOG_FILE"' ERR

# --- Setup ---
mkdir -p "$BACKUP_DIR"
cd "$PROJECT_DIR"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# --- Export ---
log "Starting backup..."
npx wrangler d1 export "$DB_NAME" --remote --output="$BACKUP_FILE" 2>&1 | tee -a "$LOG_FILE"

# --- Compress ---
gzip -f "$BACKUP_FILE"

# --- Validate ---
if [ ! -s "$BACKUP_GZ" ]; then
    log "ERROR: Backup file is empty or missing"
    exit 1
fi
BACKUP_SIZE=$(stat -f%z "$BACKUP_GZ")
log "Backup complete: journal-${DATE}.sql.gz ($(( BACKUP_SIZE / 1024 )) KB)"

# --- Rotate ---
find "$BACKUP_DIR" -name "journal-*.sql.gz" -mtime +${RETENTION_DAYS} -delete

# --- Summary ---
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -name "journal-*.sql.gz" | wc -l | tr -d ' ')
log "Done. ${TOTAL_BACKUPS} backups on disk."
exit 0
