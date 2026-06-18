#requires -Version 5
<#
.SYNOPSIS
  Turn this (home) Windows machine into a Tailscale scraping host: launch Chrome
  with the DevTools port, then hold open a REVERSE SSH tunnel to the server so
  `scripts/browser-tools.ts` over there drives this browser from a residential IP
  (and doesn't get auto-blocked from the datacenter IP).

.DESCRIPTION
  Why reverse: this machine's network only carries OUTBOUND TCP, so the server
  cannot SSH in. Instead this machine dials out and remote-forwards (`ssh -R`)
  its Chrome port onto the server's localhost:9222. browser-tools.ts on the
  server talks to localhost:9222 unchanged.

  Both ends are pinned to 127.0.0.1 on purpose: `localhost` can resolve to IPv6
  ::1, but Chrome's debug server binds IPv4 127.0.0.1 only -> empty replies.

  The tunnel auto-reconnects if it drops. Leave this window running.

.PARAMETER ServerUser   SSH user on the server (default: patrick)
.PARAMETER ServerIp     Server's Tailscale IP (default: 100.97.144.34 = vultr)
.PARAMETER Port         CDP / forwarded port on both ends (default: 9222)
.PARAMETER ChromePath   Override Chrome binary auto-detection.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\home-browser-host.ps1

.NOTES
  Unattended startup needs key-based SSH (no password prompt). One-time:
    ssh-keygen -t ed25519                       # accept defaults
    type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh patrick@100.97.144.34 `
      "cat >> ~/.ssh/authorized_keys"
  Run at logon (Task Scheduler):
    schtasks /Create /TN "BrowserHost" /SC ONLOGON /RL LIMITED /F /TR `
      "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\scripts\home-browser-host.ps1`""
#>
param(
  [string]$ServerUser = 'patrick',
  [string]$ServerIp   = '100.97.144.34',
  [int]   $Port       = 9222,
  [string]$ChromePath
)

$ErrorActionPreference = 'Stop'

function Test-Cdp {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3 | Out-Null
    return $true
  } catch { return $false }
}

# --- 1. Locate Chrome --------------------------------------------------------
if (-not $ChromePath) {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )
  $ChromePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ChromePath) { throw "Chrome not found. Pass -ChromePath 'C:\path\to\chrome.exe'." }

# --- 2. Launch Chrome with remote debugging (skip if already serving) --------
if (Test-Cdp) {
  Write-Host "CDP already live on 127.0.0.1:$Port" -ForegroundColor Green
} else {
  $profileDir = Join-Path $env:TEMP 'cdp-profile'
  Write-Host "Launching Chrome: $ChromePath (port $Port)"
  Start-Process -FilePath $ChromePath -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$profileDir`"",
    '--no-first-run',
    '--no-default-browser-check'
  )
  for ($i = 0; $i -lt 30 -and -not (Test-Cdp); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Cdp)) {
    throw "Chrome did not open CDP on $Port. If a Chrome was already running, it ignores the flag - close ALL Chrome windows and rerun."
  }
  Write-Host "CDP up on 127.0.0.1:$Port" -ForegroundColor Green
}

# --- 3. Hold the reverse tunnel open, reconnecting on drop -------------------
$sshArgs = @(
  '-N',
  '-R', "${Port}:127.0.0.1:$Port",
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new',
  "$ServerUser@$ServerIp"
)
Write-Host "Reverse tunnel: server:$Port -> here 127.0.0.1:$Port  (Ctrl+C to stop)" -ForegroundColor Cyan
while ($true) {
  & ssh @sshArgs
  Write-Host "Tunnel closed (ssh exit $LASTEXITCODE). Reconnecting in 5s..." -ForegroundColor Yellow
  Start-Sleep -Seconds 5
}
