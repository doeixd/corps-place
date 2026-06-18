# Publishes data produced on the laptop:
#   1. Back up sdk/dci-relational.db to Cloudflare R2 via restic.
#   2. Emit the read-model from sdk/dci-relational.db.
#   3. Push the emitted read-model to the selected Turso DB.
#
# This is the CANONICAL data-update path (Turso). The app reads it via its embedded
# replica, which auto-syncs within ~READ_MODEL_SYNC_INTERVAL_MS (default 60s). Two
# things to know:
#   - An env only *consumes* the push if READ_MODEL_REPLICA_ENABLED=1 is set on its
#     container (prod: yes; dev: must be enabled — see docs/INFRASTRUCTURE.md §4).
#   - A long-running server stays on the old replication generation until it
#     restarts (the self-healing replica rebuilds fresh on start); redeploy or
#     restart the app to force an immediate pickup, else it lands on the next deploy.
# On the VM itself, use the bash counterpart `scripts/publish-read-model.sh <env> [--restart]`.
#
# Usage:
#   pwsh -File scripts/publish-data.ps1 -Env dev
#   pwsh -File scripts/publish-data.ps1 -Env prod
#   pwsh -File scripts/publish-data.ps1 -Env dev -SkipBackup
#   pwsh -File scripts/publish-data.ps1 -Env dev -IncludeJsonSnapshot
#
# Required .env vars:
#   For backup: RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   For prod Turso: READ_MODEL_SYNC_URL, READ_MODEL_AUTH_TOKEN
#   For dev Turso:  READ_MODEL_SYNC_URL_DEV, READ_MODEL_AUTH_TOKEN_DEV

param(
  [ValidateSet('dev', 'prod')]
  [string]$Env = 'dev',

  [switch]$SkipBackup,
  [switch]$SkipTurso,
  [switch]$IncludeJsonSnapshot
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env'

if (-not (Test-Path $envFile)) {
  throw ".env not found at $envFile"
}

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    Set-Item -Path "Env:$($matches[1])" -Value ($matches[2].Trim().Trim('"').Trim("'"))
  }
}

if (-not $SkipBackup) {
  Write-Host "[publish-data] backing up relational DB to R2"
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'backup-relational.ps1')
  if ($LASTEXITCODE -ne 0) { throw "backup-relational.ps1 failed ($LASTEXITCODE)" }
}

if ($Env -eq 'dev') {
  $syncUrl = $env:READ_MODEL_SYNC_URL_DEV
  $authToken = $env:READ_MODEL_AUTH_TOKEN_DEV
} else {
  $syncUrl = $env:READ_MODEL_SYNC_URL
  $authToken = $env:READ_MODEL_AUTH_TOKEN
}

$emitArgs = @('tsx', 'scripts/emitReadModel.ts')
if ($IncludeJsonSnapshot) {
  $emitArgs += @('--json-snapshot', '../public/read-model')
}
if (-not $SkipTurso) {
  if (-not $syncUrl) { throw "Missing Turso sync URL for $Env" }
  if (-not $authToken) { throw "Missing Turso auth token for $Env" }
  $emitArgs += @('--push-turso', $syncUrl, '--turso-auth-token', $authToken)
}

Write-Host "[publish-data] emitting read-model for $Env"
Push-Location (Join-Path $repoRoot 'sdk')
try {
  & npx @emitArgs
  if ($LASTEXITCODE -ne 0) { throw "emitReadModel failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host "[publish-data] done"
