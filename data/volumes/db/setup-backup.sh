#!/bin/bash
set -e

user="$(id -u)"

function wait_for_recovery() {
  while ! psql -c 'SELECT 1' &>/dev/null; do
    echo "Waiting for PostgreSQL to accept connections..."
    sleep 1
  done
}

if [ "$user" = "0" ]; then
  # Derive script that sets up the database but does not yet start the server (by commenting out the final exec line)
  sed -E 's/(^[[:space:]]*)exec "\$@"([[:space:]]*)$/\1# exec "$@"\2/' /usr/local/bin/docker-entrypoint.sh > /usr/local/bin/setup-database.sh

  chmod +x /usr/local/bin/setup-database.sh
  /usr/local/bin/setup-database.sh "$@"

  # run again as postgres for the backup setup
  exec gosu postgres "$BASH_SOURCE" "$@"
else # not root (postgres user)
  source /usr/local/bin/setup-database.sh
  echo "Setting up backup functions"
  docker_temp_server_start "$@"
  wait_for_recovery
  docker_process_sql -f /usr/local/share/wal-g/backup.sql
  docker_temp_server_stop
fi
