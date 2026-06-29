#!/usr/bin/env bash
# One-shot: install + configure earlyoom so this 3.8 GiB box never hard-OOMs /
# reboots again. When free RAM+swap gets critically low, earlyoom kills the single
# hungriest *non-critical* process instead of letting the kernel freeze or take the
# whole machine down (the 2026-06-29 reboot). Reversible: `apt remove earlyoom`.
#
# Run ONCE with root:  sudo bash scripts/setup-oom-protection.sh
# Idempotent — safe to re-run (it rewrites the config + restarts the service).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must run as root:  sudo bash scripts/setup-oom-protection.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq earlyoom

# -m / -s: act when BOTH free RAM < 6% AND free swap < 6% (avail-based).
# -n:       d-bus notifications. -r 3600: hourly memory report for diagnosis.
# --prefer: kill the memory-heavy, restartable jobs first (cron Node/ML/scrapers).
# --avoid:  never sacrifice the infrastructure that keeps the box reachable/serving.
# (earlyoom always picks the victim by RSS/oom_score — no sort flag exists in v1.7.)
cat >/etc/default/earlyoom <<'EOF'
EARLYOOM_ARGS="-m 6 -s 6 -r 3600 -n \
  --prefer '(^|/)(node|tsx|chrome|chromium|chromium-browser|puppeteer|python3?|tfjs)' \
  --avoid '(^|/)(systemd|dockerd|containerd|sshd|tailscaled|traefik|init)$'"
EOF

systemctl enable --now earlyoom
systemctl restart earlyoom
echo "--- earlyoom status ---"
systemctl --no-pager --full status earlyoom | head -15
echo
echo "earlyoom active. It will now kill one offending process under memory pressure"
echo "instead of letting the box reboot. Verify later with: journalctl -u earlyoom"
