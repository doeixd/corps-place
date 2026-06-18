# Backs up sdk/dci-relational.db to the restic repo on Cloudflare R2, then prunes
# to a retention policy. Credentials + repo come from the gitignored repo-root .env
# (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
#
# Run manually:   pwsh -File scripts\backup-relational.ps1
# Scheduled:      registered as the "corps-place-db-backup" task (see below).
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile  = Join-Path $repoRoot '.env'
$dbPath   = Join-Path $repoRoot 'sdk\dci-relational.db'

# Load .env into the process environment (restic reads RESTIC_* / AWS_* from env).
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    Set-Item -Path "Env:$($matches[1])" -Value ($matches[2].Trim().Trim('"').Trim("'"))
  }
}

# Resolve the winget-installed restic.exe (no machine PATH entry).
$restic = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\restic.restic*" `
  -Recurse -Filter 'restic_*.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $restic) { throw 'restic.exe not found' }

if (-not (Test-Path $dbPath)) { throw "DB not found: $dbPath" }

Write-Host "[backup] $(Get-Date -Format s)  backing up $dbPath"
& $restic backup $dbPath --tag dci-relational --host corps-place
if ($LASTEXITCODE -ne 0) { throw "restic backup failed ($LASTEXITCODE)" }

# Retention: keep last 7 daily, 4 weekly, 6 monthly snapshots; prune the rest.
& $restic forget --tag dci-relational --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
if ($LASTEXITCODE -ne 0) { throw "restic forget/prune failed ($LASTEXITCODE)" }

Write-Host "[backup] $(Get-Date -Format s)  done"
