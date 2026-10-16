#!/bin/sh
# Lantern database backups.
#   backup.sh loop   run forever: one backup a day at BACKUP_AT (UTC, HH:MM)
#   backup.sh now    take one backup and exit
# Keeps BACKUP_KEEP_DAILY daily and BACKUP_KEEP_WEEKLY weekly (Sunday) dumps.
# With BACKUP_S3_BUCKET set, each dump is also uploaded to S3-compatible storage.
set -eu

DIR=/backups
KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${BACKUP_KEEP_WEEKLY:-4}
AT=${BACKUP_AT:-03:15}

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

prune() {
  # $1 = glob prefix, $2 = how many to keep (newest first)
  ls -1t "$DIR"/$1*.dump 2>/dev/null | tail -n +"$(($2 + 1))" | while read -r old; do
    rm -f "$old" && log "removed $(basename "$old")"
  done
}

take() {
  mkdir -p "$DIR"
  stamp=$(date -u +%Y%m%d-%H%M%S)
  kind=daily
  [ "$(date -u +%u)" = "7" ] && kind=weekly
  file="$DIR/lantern-$kind-$stamp.dump"
  tmp="$file.partial"
  log "dumping to $(basename "$file")"
  pg_dump --format=custom --compress=9 --no-owner --file="$tmp"
  mv "$tmp" "$file"
  log "done ($(du -h "$file" | cut -f1))"
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    endpoint=""
    [ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint="--endpoint-url $BACKUP_S3_ENDPOINT"
    # shellcheck disable=SC2086
    aws $endpoint s3 cp "$file" "s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-lantern}/$(basename "$file")" --only-show-errors \
      && log "uploaded to s3://$BACKUP_S3_BUCKET" || log "UPLOAD FAILED (the local copy is kept)"
  fi
  prune lantern-daily- "$KEEP_DAILY"
  prune lantern-weekly- "$KEEP_WEEKLY"
}

seconds_until() {
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%F) $1:00" +%s 2>/dev/null || date -u -D "%Y-%m-%d %H:%M:%S" -d "$(date -u +%F) $1:00" +%s)
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo $((target - now))
}

case "${1:-loop}" in
  now) take ;;
  loop)
    log "scheduled daily at $AT UTC (keeping $KEEP_DAILY daily, $KEEP_WEEKLY weekly)"
    while true; do
      sleep "$(seconds_until "$AT")"
      take || log "BACKUP FAILED"
    done
    ;;
  *) echo "usage: backup.sh [loop|now]" >&2; exit 2 ;;
esac
