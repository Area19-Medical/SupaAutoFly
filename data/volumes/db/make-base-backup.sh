#!/bin/bash
exec > >(tee -a /var/log/wal-g/base-backup.log) 2>&1
wal-g backup-push ~/data
if [ "$WALG_RETAIN_FULL" != "all" ]; then
  wal-g delete retain --confirm FIND_FULL ${WALG_RETAIN_FULL:-"7"}
fi
