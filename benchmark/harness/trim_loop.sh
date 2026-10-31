#!/bin/sh
# Docker (Colima) keeps the blocks of deleted task images until the VM disk is trimmed; without this the host fills up within hours.
while pgrep -f run_live_all.py >/dev/null; do
  sleep 1200
  colima ssh -- sudo fstrim -a >/dev/null 2>&1
done
