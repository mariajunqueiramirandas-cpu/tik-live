#!/bin/sh
# Restores a dump into a database (default: a scratch database, for drills).
#   restore.sh /backups/lantern-daily-....dump [target-database]
# Restoring into the live database is deliberate: stop the app first, then
#   restore.sh <file> lantern
set -eu
file=${1:?usage: restore.sh <dump-file> [database]}
target=${2:-lantern_restore_check}
if [ "$target" != "${PGDATABASE:-lantern}" ]; then
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\""
fi
pg_restore --clean --if-exists --no-owner --exit-on-error -d "$target" "$file"
echo "restored $(basename "$file") into $target"
psql -d "$target" -At -c "select 'channels: ' || count(*) from channel" -c "select 'users: ' || count(*) from app_user"
