#!/bin/bash
set -e

if [ -n "$WALG_S3_PREFIX" -o -n "$WALG_SSH_PREFIX" ]; then
  cat <<EOF
# - Archiving -

archive_mode = on
archive_command = '/usr/local/bin/wal-g wal-push %p >> /var/log/wal-g/wal-push.log 2>&1'
archive_timeout = ${WALG_ARCHIVE_TIMEOUT:-"2min"}

# - Archive Recovery -

restore_command = '/usr/local/bin/wal-g wal-fetch %f %p >> /var/log/wal-g/wal-fetch.log 2>&1'

EOF
else
  cat <<EOF
# - Archiving -

# archive_mode = on
# archive_command = '/usr/local/bin/wal-g wal-push %p >> /var/log/wal-g/wal-push.log 2>&1'
# archive_timeout = ${WALG_ARCHIVE_TIMEOUT:-"2min"}

# - Archive Recovery -

# restore_command = '/usr/local/bin/wal-g wal-fetch %f %p >> /var/log/wal-g/wal-fetch.log 2>&1'

EOF
fi
cat <<EOF
# - Recovery Target -

#recovery_target_lsn = ''
#recovery_target_time = '2025-07-10 22:44:00+02'
recovery_target_action = 'promote'
#recovery_target_timeline = 'current'
#recovery_target_inclusive = off

# - Hot Standby -
hot_standby = off
EOF
