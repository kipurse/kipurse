#!/bin/bash
# t784 restore with erase enforcement. Usage (root): restore-backup.sh /opt/kipurse-main/backups/main-<T>.tar.gz.enc
# - restores data/ (and config/ only with --config); NEVER overwrites shared/tombstones (newer erasures must win)
# - merges tombstones found in the backup into the live tombstone file (union), so a lost disk does not forget erasures
# - refuses to start unless the live tombstone file is readable; on boot the runtime re-runs the erase for every tombstoned
#   wallet whose restored state predates its tombstone (log event tombstone_check reason=reapplied)
set -euo pipefail; [ $EUID -eq 0 ] || { echo "run as root"; exit 1; }
B=${1:?backup file}; CFG=${2:-}; SH=/opt/kipurse-main/shared; K=/opt/kipurse-main/keys/backup.key; TB=$SH/tombstones/erased.jsonl
[ -f "$K" ] || { echo "no backup key"; exit 1; }
mkdir -p $SH/tombstones; chmod 700 $SH/tombstones; touch $TB; chmod 600 $TB; chown -R kipurse-main:kipurse-main $SH/tombstones
[ -r "$TB" ] || { echo "tombstone file unreadable: refusing"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S); ST=$(mktemp -d /root/kipurse-restore-$TS.XXXX)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:$K -in "$B" | tar xzf - -C "$ST"
[ -d "$ST/data" ] || { echo "backup has no data/"; exit 1; }
if [ -f "$ST/tombstones/erased.jsonl" ]; then sort -u "$TB" "$ST/tombstones/erased.jsonl" > "$TB.new" && mv "$TB.new" "$TB"; chmod 600 $TB; chown kipurse-main:kipurse-main $TB; fi
systemctl stop kipurse-main
PRE=$(mktemp -d /root/kipurse-pre-restore-$TS.XXXX); mv $SH/data $PRE/data; cp -a "$ST/data" $SH/data
[ "$CFG" = "--config" ] && { mv $SH/config $PRE/config; cp -a "$ST/config" $SH/config; }
chown -R kipurse-main:kipurse-main $SH/data; systemctl start kipurse-main
for i in $(seq 1 30); do L=$(journalctl -u kipurse-main --since "-2 min" -o cat --no-pager | grep '"tombstone_check"' | tail -1 || true); [ -n "$L" ] && break; sleep 2; done   # t789: no match yet must keep waiting, not abort (set -e + pipefail)
echo "restored $B (previous data kept in $PRE/data)"; echo "boot check: ${L:-NOT SEEN - check the service}"
case "$L" in *'"reason":"clean"'*|*'"reason":"reapplied"'*) exit 0;; *) exit 2;; esac
