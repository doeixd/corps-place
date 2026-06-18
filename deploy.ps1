# deploy.ps1 - Build and restart the local production server/tunnel.

param(
    [switch]$Tunnel,
    [switch]$NoTunnel,
    [switch]$SkipBuild,
    [switch]$SkipEmit,   # don't (re)emit the read-model on this deploy
    [switch]$Emit,       # force a read-model emit even with -SkipBuild/-Start
    [switch]$Start,      # bring up the last build with no rebuild/emit (fast restart)
    [switch]$Dev,
    [switch]$Status,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

# -Start is a fast restart of the existing build: skip both the build and the emit.
if ($Start) { $SkipBuild = $true; $SkipEmit = $true }

$Root = $PSScriptRoot
# Read-model (READ_MODEL_PLAN): the prod backend reads page data from this small
# precomputed DB instead of the 3.4 GB relational DB. Emitted from sdk/ before the
# backend is warmed so the new process opens a current file.
$SdkDir = Join-Path $Root "sdk"
# Base path: the server derives the A/B slot files (read-model.a.db / .b.db) and
# the pointer (read-model.active) from this. The emit publishes into the inactive
# slot and flips the pointer; the server hot-swaps with no restart (zero downtime).
$ReadModelDb = Join-Path $SdkDir "read-model.db"
$ReadModelDbUrl = "file:$ReadModelDb"
$ReadModelPointer = Join-Path $SdkDir "read-model.active"
$StatusFile = Join-Path $Root ".deploy-status.json"
$ServerOutLog = Join-Path $Root ".server-output.log"
$ServerErrLog = Join-Path $Root ".server-error.log"
$TunnelOutLog = Join-Path $Root ".tunnel-output.log"
$TunnelErrLog = Join-Path $Root ".tunnel-error.log"
$Port = 3000 # public port: the h3 proxy in production, or the vite dev server directly
# Production runs a persistent h3 reverse proxy on $Port that the tunnel points at
# permanently. The actual app server (backend) runs on one of these spare ports;
# deploys warm the new build on the unused one, flip the proxy's upstream in-place
# (no restart, so the tunnel never drops), then retire the old backend.
$BackendPortA = 3001
$BackendPortB = 3002
$ProxyScript = Join-Path $Root "proxy.mjs"
$ProxyTargetFile = Join-Path $Root ".proxy-target"
$ProxyOutLog = Join-Path $Root ".proxy-output.log"
$ProxyErrLog = Join-Path $Root ".proxy-error.log"
$TunnelName = "drumcorps"
$TunnelUrl = "https://drumcorps.app"
$CloudflaredConfig = Join-Path $env:USERPROFILE ".cloudflared\config.yml"

function Read-DeployStatus {
    if (Test-Path $StatusFile) {
        return Get-Content $StatusFile -Raw | ConvertFrom-Json
    }
    return $null
}

function Write-DeployStatus {
    param(
        [int]$ServerProcessId,
        [Nullable[int]]$ProxyProcessId,
        [Nullable[int]]$BackendPort,
        [Nullable[int]]$TunnelProcessId,
        [string]$BuildTime,
        [int]$Port
    )

    [ordered]@{
        serverPid = $ServerProcessId
        proxyPid = $ProxyProcessId
        backendPort = $BackendPort
        tunnelPid = $TunnelProcessId
        lastBuild = $BuildTime
        port = $Port
        startedAt = (Get-Date -Format "o")
        serverLog = $ServerOutLog
        serverErrorLog = $ServerErrLog
        proxyLog = $ProxyOutLog
        proxyErrorLog = $ProxyErrLog
        tunnelLog = $TunnelOutLog
        tunnelErrorLog = $TunnelErrLog
    } | ConvertTo-Json | Set-Content $StatusFile
}

function Test-ProcessRunning {
    param([Nullable[int]]$ProcessId)
    if (-not $ProcessId) { return $false }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree {
    param([Nullable[int]]$ProcessId)
    if (-not $ProcessId) { return }

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
    }

    if (Test-ProcessRunning $ProcessId) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped PID $ProcessId" -ForegroundColor Yellow
    }
}

function Stop-PortListener {
    param([int]$Port)
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        Write-Host "Stopping process on port $Port (PID: $($listener.OwningProcess))..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId ([int]$listener.OwningProcess)
    }
}

function Stop-DrumcorpsTunnels {
    param([Nullable[int]]$ExceptPid)

    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "cloudflared.exe" -and
            $_.CommandLine -match "tunnel\s+run\s+$TunnelName" -and
            (-not $ExceptPid -or $_.ProcessId -ne $ExceptPid)
        }

    foreach ($process in $processes) {
        Write-Host "Stopping duplicate tunnel (PID: $($process.ProcessId))..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId ([int]$process.ProcessId)
    }
}

function Stop-LegacyInteractiveDeployProcesses {
    $escapedRoot = [regex]::Escape($Root)
    $allProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $processes = @($allProcesses | Where-Object {
            $_.Name -eq "cmd.exe" -and
            (
                $_.CommandLine -match "cmd /k cd /d $escapedRoot\s+&&\s+node \.output/server/index\.mjs" -or
                $_.CommandLine -match "cmd /k cd /d\s+&&\s+node \.output/server/index\.mjs" -or
                $_.CommandLine -match "cmd /k cloudflared tunnel run $TunnelName"
            )
        })
    $processes += @($allProcesses | Where-Object {
                $_.Name -eq "powershell.exe" -and
                $_.CommandLine -match "\s-NoExit\s+-Command\s+Set-Location '$escapedRoot';" -and
                $_.CommandLine -match "node \.output/server/index\.mjs"
            })
    $processes = $processes | Where-Object { $_ }

    foreach ($process in $processes) {
        Write-Host "Stopping legacy interactive deploy shell (PID: $($process.ProcessId))..." -ForegroundColor Yellow
        Stop-ProcessTree -ProcessId ([int]$process.ProcessId)
    }
}

function Wait-ForHttpOk {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            # 20s per-request: a cold Vite dev SSR render of the probed route can
            # take well over the old 3s, which made every probe time out and the
            # readiness gate (falsely) give up on an otherwise-healthy dev server.
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $true
            }
        } catch {
            Start-Sleep -Milliseconds 750
        }
    }
    return $false
}

# Post-start smoke check: confirm the image proxy can produce a resized WebP.
# This exercises the native `sharp` dependency end-to-end at runtime -- the exact
# thing that's fragile (native binary / DLL, externalized from the bundle). A
# failure here means logos fall back to multi-MB originals, so it's worth surfacing.
function Test-ImageResize {
    param([int]$Port)
    try {
        $corps = Invoke-WebRequest -Uri "http://localhost:$Port/corps" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
        $m = [regex]::Match($corps.Content, 'u=([^"&]+)')
        if (-not $m.Success) {
            Write-Host "  [warn] image resize: no proxied logo URL found on /corps to test." -ForegroundColor Yellow
            return $false
        }
        $u = $m.Groups[1].Value
        $img = Invoke-WebRequest -Uri "http://localhost:$Port/api/media?u=$u&w=144" -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
        $ct = [string]$img.Headers.'Content-Type'
        if ($img.StatusCode -eq 200 -and $ct -like 'image/webp*') {
            Write-Host "  [ok] image resize: $($img.RawContentLength) bytes WebP (sharp working)." -ForegroundColor Green
            return $true
        }
        Write-Host "  [warn] image resize: unexpected response (HTTP $($img.StatusCode), $ct)." -ForegroundColor Yellow
        return $false
    } catch {
        Write-Host "  [warn] image resize check failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

# Confirm the tunnel actually connected by watching its log for a registered
# connection. We deliberately do NOT probe the public URL: Cloudflare's bot
# protection 403s CLI clients, so a public fetch gives a false negative even when
# a browser loads the site fine.
function Wait-ForTunnelRegistered {
    param([int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        # cloudflared logs to stderr, but check both streams to be safe.
        $log = (Get-Content $TunnelErrLog, $TunnelOutLog -Raw -ErrorAction SilentlyContinue) -join "`n"
        if ($log -match 'Registered tunnel connection') { return $true }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

# Re-point the cloudflared ingress at a localhost port by rewriting config.yml.
# Cloudflared on Windows has no hot-reload (no SIGHUP), so the caller restarts the
# tunnel after this; the rewrite just makes the new target take effect on restart.
function Set-IngressPort {
    param([int]$TargetPort)
    if (-not (Test-Path $CloudflaredConfig)) {
        Write-Host "  [warn] cloudflared config not found at $CloudflaredConfig; tunnel target unchanged." -ForegroundColor Yellow
        return
    }
    $content = Get-Content $CloudflaredConfig -Raw
    $updated = [regex]::Replace($content, 'http://localhost:\d+', "http://localhost:$TargetPort")
    if ($updated -ne $content) {
        Set-Content -Path $CloudflaredConfig -Value $updated -NoNewline
    }
}

# Point the running proxy at a backend by rewriting `.proxy-target`; the proxy
# polls this file and swaps its upstream in-process (no restart).
function Set-ProxyTarget {
    param([int]$BackendPort)
    Set-Content -Path $ProxyTargetFile -Value "http://localhost:$BackendPort" -NoNewline
}

function Test-ProxyHealthy {
    param([int]$ProxyPort)
    try {
        return (Invoke-WebRequest -Uri "http://localhost:$ProxyPort/__proxy_health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).StatusCode -eq 200
    } catch {
        return $false
    }
}

# Start the persistent h3 proxy on the public port, seeded to $BackendPort.
# Frees the public port first (e.g. a pre-proxy server still squatting it).
# Returns the proxy PID, or $null if it didn't come up.
function Start-ProxyServer {
    param([int]$ProxyPort, [int]$BackendPort)
    Set-ProxyTarget -BackendPort $BackendPort
    Stop-PortListener -Port $ProxyPort
    $env:PROXY_PORT = [string]$ProxyPort
    $env:PROXY_FALLBACK_PORT = [string]$BackendPort
    $proc = Start-Process -FilePath "node" `
        -ArgumentList $ProxyScript `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $ProxyOutLog `
        -RedirectStandardError $ProxyErrLog `
        -PassThru
    if (Wait-ForHttpOk -Url "http://localhost:$ProxyPort/__proxy_health" -TimeoutSeconds 15) {
        return $proc.Id
    }
    return $null
}

# Emit the read-model (sdk/scripts/emitReadModel.ts) so the new backend serves
# fresh page data. Emits unless -SkipEmit, or forces with -Emit. If no read-model
# has been published yet (no pointer) it always emits (a backend with
# READ_MODEL_DB_URL set but no slot would fall back to the big DB). The emit
# publishes into the inactive A/B slot and flips the pointer, so a running server
# hot-swaps with no restart -- this can even be run outside a deploy. Non-fatal: a
# failed emit leaves the previous read-model (pointer unchanged).
function Update-ReadModel {
    $missing = -not (Test-Path $ReadModelPointer)
    if ($SkipEmit -and -not $Emit -and -not $missing) {
        Write-Host "Skipping read-model emit (-SkipEmit)." -ForegroundColor Yellow
        return
    }
    if ($missing) {
        Write-Host "No published read-model -- emitting (first A/B slot) ..." -ForegroundColor Cyan
    } else {
        Write-Host "Emitting read-model (A/B hot-swap)..." -ForegroundColor Cyan
    }
    Push-Location $SdkDir
    try {
        & npx tsx scripts/emitReadModel.ts
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [warn] read-model emit exited $LASTEXITCODE -- keeping the previous read-model." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  [warn] read-model emit failed: $($_.Exception.Message) -- keeping the previous read-model." -ForegroundColor Yellow
    } finally {
        Pop-Location
    }
}

function Show-DeployStatus {
    $deployState = Read-DeployStatus
    if (-not $deployState) {
        Write-Host "No deploy status found. Nothing deployed yet." -ForegroundColor Yellow
        return
    }

    Write-Host "Deploy Status" -ForegroundColor Cyan
    Write-Host "=============" -ForegroundColor Cyan
    Write-Host "Started at: $($deployState.startedAt)"
    Write-Host "Last build: $($deployState.lastBuild)"
    Write-Host "Port: $($deployState.port)"
    Write-Host ""

    if ($deployState.proxyPid) {
        $proxyRunning = Test-ProcessRunning ([Nullable[int]]$deployState.proxyPid)
        Write-Host "Proxy  (PID $($deployState.proxyPid), port $($deployState.port)): " -NoNewline
        Write-Host ($(if ($proxyRunning) { "RUNNING" } else { "STOPPED" })) -ForegroundColor $(if ($proxyRunning) { "Green" } else { "Red" })
    }

    $serverRunning = Test-ProcessRunning ([Nullable[int]]$deployState.serverPid)
    $backendLabel = if ($deployState.backendPort) { ", port $($deployState.backendPort)" } else { "" }
    Write-Host "Server (PID $($deployState.serverPid)$backendLabel): " -NoNewline
    Write-Host ($(if ($serverRunning) { "RUNNING" } else { "STOPPED" })) -ForegroundColor $(if ($serverRunning) { "Green" } else { "Red" })

    if ($deployState.tunnelPid) {
        $tunnelRunning = Test-ProcessRunning ([Nullable[int]]$deployState.tunnelPid)
        Write-Host "Tunnel (PID $($deployState.tunnelPid)): " -NoNewline
        Write-Host ($(if ($tunnelRunning) { "RUNNING" } else { "STOPPED" })) -ForegroundColor $(if ($tunnelRunning) { "Green" } else { "Red" })
    }

    Write-Host ""
    Write-Host "Server log: $($deployState.serverLog)"
    Write-Host "Tunnel log: $($deployState.tunnelLog)"
}

if ($Status) {
    Show-DeployStatus
    exit 0
}

if ($Stop) {
    $deployState = Read-DeployStatus
    Write-Host "Stopping deployed processes..." -ForegroundColor Cyan

    if ($deployState) {
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.tunnelPid)
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.proxyPid)
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.serverPid)
    }

    # Clear the public proxy port and both backend ports.
    Stop-PortListener -Port $Port
    Stop-PortListener -Port $BackendPortA
    Stop-PortListener -Port $BackendPortB
    Stop-DrumcorpsTunnels -ExceptPid $null
    Stop-LegacyInteractiveDeployProcesses
    Remove-Item $StatusFile -ErrorAction SilentlyContinue
    Write-Host "All stopped." -ForegroundColor Green
    exit 0
}

$deployState = Read-DeployStatus
$buildTime = if ($deployState) { [string]$deployState.lastBuild } else { "skipped" }

if ($Dev) {
    Write-Host "Dev mode: serving the Vite dev server (no production build)." -ForegroundColor Yellow
    $buildTime = "dev (vite)"
} elseif (-not $SkipBuild) {
    Write-Host "Building production bundle..." -ForegroundColor Cyan
    $buildStart = Get-Date
    Push-Location $Root
    try {
        npm run build
    } finally {
        Pop-Location
    }
    $elapsed = [math]::Round(((Get-Date) - $buildStart).TotalSeconds, 1)
    $buildTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "Build complete in ${elapsed}s." -ForegroundColor Green
} else {
    Write-Host "Skipping build." -ForegroundColor Yellow
}

$wantTunnel = $Tunnel -or (-not $NoTunnel -and $deployState -and $deployState.tunnelPid)
$serverProcess = $null
$tunnelProcessId = $null
$proxyPid = $null
$activePort = $Port
$backendPort = $Port

if (-not $Dev) {
    # ---- Zero-downtime production deploy ----
    # A persistent h3 proxy owns the public port; the app server (backend) runs on
    # a spare port behind it. Warm the new build on the unused spare port, flip the
    # proxy's upstream in-place (no restart -> tunnel never drops), then retire the
    # old backend. A failed new build leaves the current one serving.
    $oldBackend = if ($deployState -and $deployState.backendPort) { [int]$deployState.backendPort } else { 0 }
    $newBackend = if ($oldBackend -eq $BackendPortA) { $BackendPortB } else { $BackendPortA }

    # Refresh the read-model before warming the new backend so it opens a current
    # file. (On Linux the rename-over-open swap succeeds while the old backend
    # still holds the previous file; the new backend opens the fresh one.)
    Update-ReadModel

    Write-Host "Warming new backend on port $newBackend..." -ForegroundColor Cyan
    Stop-PortListener -Port $newBackend # clear any stray listener on the spare port
    $env:PORT = [string]$newBackend
    $env:NODE_ENV = "production"
    # Serve page reads from the precomputed read-model (builder fallback if unset).
    $env:READ_MODEL_DB_URL = $ReadModelDbUrl
    $serverProcess = Start-Process -FilePath "node" `
        -ArgumentList ".output/server/index.mjs" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $ServerOutLog `
        -RedirectStandardError $ServerErrLog `
        -PassThru

    if (-not (Wait-ForHttpOk -Url "http://localhost:$newBackend" -TimeoutSeconds 45)) {
        Write-Host "New backend failed its health check -- keeping the current deploy live. Recent stderr:" -ForegroundColor Red
        Get-Content $ServerErrLog -Tail 80 -ErrorAction SilentlyContinue
        Stop-ProcessTree -ProcessId $serverProcess.Id
        exit 1
    }
    Write-Host "New backend ready on http://localhost:$newBackend (PID: $($serverProcess.Id))" -ForegroundColor Green

    Write-Host "Verifying deploy..." -ForegroundColor Cyan
    Test-ImageResize -Port $newBackend | Out-Null

    # Bring up the proxy, or hot-swap its upstream if it's already running.
    $proxyPid = if ($deployState -and $deployState.proxyPid) { [int]$deployState.proxyPid } else { 0 }
    if ((Test-ProcessRunning ([Nullable[int]]$proxyPid)) -and (Test-ProxyHealthy -ProxyPort $Port)) {
        Write-Host "Flipping proxy upstream to port $newBackend (no restart - zero downtime)..." -ForegroundColor Cyan
        Set-ProxyTarget -BackendPort $newBackend
        Start-Sleep -Milliseconds 800 # let the proxy pick up the new target + in-flight requests drain
    } else {
        Write-Host "Starting reverse proxy on http://localhost:$Port -> $newBackend..." -ForegroundColor Cyan
        $proxyPid = Start-ProxyServer -ProxyPort $Port -BackendPort $newBackend
        if (-not $proxyPid) {
            Write-Host "Proxy failed to start. Recent stderr:" -ForegroundColor Red
            Get-Content $ProxyErrLog -Tail 40 -ErrorAction SilentlyContinue
            Stop-ProcessTree -ProcessId $serverProcess.Id
            exit 1
        }
        Write-Host "Proxy running on http://localhost:$Port (PID: $proxyPid)" -ForegroundColor Green
    }

    # Ensure the tunnel is up and pointed at the proxy. Once running it's left in
    # place across deploys (the proxy port never changes), so the connection -- and
    # the site -- stay up. -Tunnel forces a fresh (re)start.
    if ($wantTunnel) {
        Set-IngressPort -TargetPort $Port
        $tunnelAlive = $deployState -and (Test-ProcessRunning ([Nullable[int]]$deployState.tunnelPid))
        if ($Tunnel -or -not $tunnelAlive) {
            Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
            if ($deployState) { Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.tunnelPid) }
            Stop-DrumcorpsTunnels -ExceptPid $null
            $tunnelProcess = Start-Process -FilePath "cloudflared" `
                -ArgumentList @("tunnel", "run", $TunnelName) `
                -WorkingDirectory $Root `
                -WindowStyle Hidden `
                -RedirectStandardOutput $TunnelOutLog `
                -RedirectStandardError $TunnelErrLog `
                -PassThru
            $tunnelProcessId = $tunnelProcess.Id
            Start-Sleep -Seconds 3
            Stop-DrumcorpsTunnels -ExceptPid $tunnelProcessId
            if (Wait-ForTunnelRegistered -TimeoutSeconds 20) {
                Write-Host "  [ok] tunnel: registered a Cloudflare connection." -ForegroundColor Green
            } else {
                Write-Host "  [warn] tunnel: no registered connection yet -- check $TunnelErrLog." -ForegroundColor Yellow
            }
        } else {
            $tunnelProcessId = [int]$deployState.tunnelPid
            Write-Host "Tunnel already running (PID: $tunnelProcessId) -- left in place (no reconnect)." -ForegroundColor Green
        }
    }

    # Retire the old backend now that the proxy targets the new one.
    if ($oldBackend -and $oldBackend -ne $newBackend) {
        Write-Host "Stopping old backend on port $oldBackend..." -ForegroundColor Cyan
        if ($deployState) { Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.serverPid) }
        Stop-PortListener -Port $oldBackend
    } elseif ($deployState -and $deployState.serverPid -and -not $deployState.proxyPid) {
        # Transition from the old (pre-proxy) scheme: that server sat on the public
        # port and was freed when the proxy started; make sure it's fully gone.
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.serverPid)
    }
    Stop-LegacyInteractiveDeployProcesses
    $backendPort = $newBackend
    $activePort = $Port

} else {
    # ---- Dev: simple stop-then-start on the public port (vite dev server) ----
    Write-Host "Stopping old server/proxy/tunnel processes..." -ForegroundColor Cyan
    if ($deployState) {
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.serverPid)
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.proxyPid)
        Stop-ProcessTree -ProcessId ([Nullable[int]]$deployState.tunnelPid)
    }
    Stop-PortListener -Port $Port
    Stop-PortListener -Port $BackendPortA
    Stop-PortListener -Port $BackendPortB
    Stop-DrumcorpsTunnels -ExceptPid $null
    Stop-LegacyInteractiveDeployProcesses
    Start-Sleep -Seconds 1

    Write-Host "Starting Vite dev server on port $Port..." -ForegroundColor Cyan
    $env:NODE_ENV = "development"
    # Point HMR's websocket at the public tunnel host (wss over 443) when we're
    # serving through the tunnel, so live reload reaches a remote browser. Cleared
    # for -NoTunnel so a purely-local dev session keeps normal localhost HMR.
    if ($NoTunnel) {
        $env:TUNNEL_HMR_HOST = $null
    } else {
        $env:TUNNEL_HMR_HOST = ([Uri]$TunnelUrl).Host
    }
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $npm = if ($npmCmd) { $npmCmd.Source } else { "npm" }
    $serverProcess = Start-Process -FilePath $npm `
        -ArgumentList @("run", "dev", "--", "--port", [string]$Port, "--strictPort") `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $ServerOutLog `
        -RedirectStandardError $ServerErrLog `
        -PassThru

    if (-not (Wait-ForHttpOk -Url "http://localhost:$Port" -TimeoutSeconds 90)) {
        Write-Host "Dev server did not become ready. Recent stderr:" -ForegroundColor Red
        Get-Content $ServerErrLog -Tail 80 -ErrorAction SilentlyContinue
        Stop-ProcessTree -ProcessId $serverProcess.Id
        exit 1
    }
    Write-Host "Dev server running at http://localhost:$Port (PID: $($serverProcess.Id))" -ForegroundColor Green

    if ($wantTunnel) {
        Set-IngressPort -TargetPort $Port
        Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
        $tunnelProcess = Start-Process -FilePath "cloudflared" `
            -ArgumentList @("tunnel", "run", $TunnelName) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput $TunnelOutLog `
            -RedirectStandardError $TunnelErrLog `
            -PassThru
        $tunnelProcessId = $tunnelProcess.Id
        Start-Sleep -Seconds 3
        Stop-DrumcorpsTunnels -ExceptPid $tunnelProcessId
        Write-Host "Tunnel starting at $TunnelUrl (PID: $tunnelProcessId)" -ForegroundColor Green
        if (Wait-ForTunnelRegistered -TimeoutSeconds 20) {
            Write-Host "  [ok] tunnel: registered a Cloudflare connection." -ForegroundColor Green
        } else {
            Write-Host "  [warn] tunnel: no registered connection yet -- check $TunnelErrLog." -ForegroundColor Yellow
        }
    }
    $backendPort = $Port
    $activePort = $Port
}

Write-DeployStatus -ServerProcessId $serverProcess.Id -ProxyProcessId $proxyPid -BackendPort $backendPort -TunnelProcessId $tunnelProcessId -BuildTime $buildTime -Port $activePort

Write-Host ""
Write-Host "Done. Status saved to .deploy-status.json" -ForegroundColor Cyan
Write-Host "  .\deploy.ps1 -Status     # Check what's running" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -Start      # Bring up the last build (no rebuild, no re-emit)" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -Stop       # Stop everything" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -SkipEmit   # Deploy without re-emitting the read-model" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -Emit       # Force a read-model emit (e.g. with -SkipBuild)" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -Dev        # Serve the Vite dev server instead of a prod build" -ForegroundColor Gray
Write-Host "  .\deploy.ps1 -NoTunnel   # Deploy local server only" -ForegroundColor Gray
