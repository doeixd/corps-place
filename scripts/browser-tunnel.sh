#!/usr/bin/env bash
#
# browser-tunnel.sh — forward a local CDP port to a home machine's Chrome over
# Tailscale, so scripts/browser-tools.ts drives a browser on a residential IP
# (and doesn't get auto-blocked from this server's datacenter IP).
#
# How it fits together:
#   home machine (mini-pc)        this box (vultr)
#   Chrome --remote-debugging-    ssh -L 9222:localhost:9222
#   port=9222 (binds localhost) <----- Tailscale ----->  browser-tools.ts
#                                                          talks to localhost:9222
#
# browser-tools.ts needs NO changes: the SSH forward makes the home machine's
# localhost:9222 appear as localhost:9222 here. Chrome's debug port stays bound
# to localhost on both ends (never exposed on the tailnet), which also sidesteps
# Chrome's "Host header must be an IP or localhost" rejection.
#
# FORWARD vs REVERSE
# ------------------
# This script runs the FORWARD form (`ssh -L`), initiated from this box, which
# needs this box -> home machine SSH (port 22) to work.
#
# If that direction is blocked but home -> this box works (e.g. the home machine
# is behind a corporate NAT/Tailscale path that only carries outbound TCP), use
# the REVERSE form instead, initiated ON THE HOME MACHINE:
#     ssh -N -R 9222:localhost:9222 <user>@<this-box-tailnet-ip>
# That publishes the home machine's Chrome port onto THIS box's localhost:9222,
# so browser-tools.ts still talks to localhost:9222 unchanged. Verify here with
# `scripts/browser-tunnel.sh --check` once the home machine's tunnel is up.
# On the home (Windows) machine, `scripts/home-browser-host.ps1` launches Chrome
# AND opens this reverse tunnel (auto-reconnecting) in one shot.
#
# Prereqs on the home machine (one-time):
#   1. Tailscale running and logged into the same tailnet.
#   2. OpenSSH Server enabled. On Windows 10/11 (PowerShell as admin):
#        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
#        Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
#   3. Chrome launched with remote debugging, e.g.:
#        "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
#          --remote-debugging-port=9222 --user-data-dir="%TEMP%\cdp-profile"
#      (or run `browser-tools.ts start` on the home machine itself).
#
# Usage:
#   scripts/browser-tunnel.sh                 # forward to the default host below
#   BROWSER_TUNNEL_HOST=mini-pc scripts/browser-tunnel.sh
#   scripts/browser-tunnel.sh --user patrick --remote-port 9222 --local-port 9222
#   scripts/browser-tunnel.sh --check         # verify CDP responds, then exit
#
set -euo pipefail

# Defaults — mini-pc on the tailnet. Override with env or flags.
HOST="${BROWSER_TUNNEL_HOST:-100.98.92.103}"   # mini-pc tailscale IP (or MagicDNS name)
USER_NAME="${BROWSER_TUNNEL_USER:-${USER:-$(id -un)}}"
LOCAL_PORT="${BROWSER_TUNNEL_LOCAL_PORT:-9222}"
REMOTE_PORT="${BROWSER_TUNNEL_REMOTE_PORT:-9222}"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)        HOST="$2"; shift 2 ;;
    --user)        USER_NAME="$2"; shift 2 ;;
    --local-port)  LOCAL_PORT="$2"; shift 2 ;;
    --remote-port) REMOTE_PORT="$2"; shift 2 ;;
    --check)       CHECK_ONLY=1; shift ;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[36mℹ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
err()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

cdp_alive() {
  # Chrome's /json/version returns 200 with JSON when the debug port is live.
  curl -fsS --max-time 3 "http://localhost:${LOCAL_PORT}/json/version" >/dev/null 2>&1
}

if [[ "$CHECK_ONLY" == "1" ]]; then
  if cdp_alive; then
    ok "CDP reachable at http://localhost:${LOCAL_PORT} (tunnel is up)"
    curl -fsS --max-time 3 "http://localhost:${LOCAL_PORT}/json/version"
    exit 0
  fi
  err "No CDP endpoint at localhost:${LOCAL_PORT}. Start the tunnel first."
  exit 1
fi

# Confirm the home machine is reachable on the tailnet before dialing SSH.
if command -v tailscale >/dev/null 2>&1; then
  if tailscale ping --c 1 --timeout 5s "$HOST" >/dev/null 2>&1; then
    ok "Tailscale path to ${HOST} is up"
  else
    err "Tailscale cannot reach ${HOST}. Is the home machine online on the tailnet?"
    log "Check with: tailscale status"
    exit 1
  fi
fi

if cdp_alive; then
  err "localhost:${LOCAL_PORT} is already serving CDP. A tunnel (or local Chrome) is already running."
  log "Reuse it, or pick another port with --local-port."
  exit 1
fi

log "Forwarding localhost:${LOCAL_PORT} -> ${USER_NAME}@${HOST}:localhost:${REMOTE_PORT}"
log "Leave this running; in another shell: npx tsx scripts/browser-tools.ts inspect"
log "Ctrl+C to close the tunnel."

# -N: no remote command (forward only). Keepalives so the tunnel survives idle.
# ExitOnForwardFailure: fail fast if the local port can't bind.
exec ssh -N \
  -L "${LOCAL_PORT}:localhost:${REMOTE_PORT}" \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  "${USER_NAME}@${HOST}"
