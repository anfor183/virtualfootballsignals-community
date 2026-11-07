<#
.SYNOPSIS
  deploy/vps-sync.ps1  -  Push code and sync databases between this PC and the VPS.

.DESCRIPTION
  ╔═══════════════════════════════════════════════════════════════════╗
  ║          THIS PC   ←── scp / ssh ──→  VPS (Ubuntu)              ║
  ║                                                                 ║
  ║  1. git push        → GitHub  → VPS git pull + pm2 reload       ║
  ║  2. DB on this PC   → export  → scp pkg → merge into VPS DB    ║
  ║  3. DB on VPS       → export  → scp pkg → merge into PC DB     ║
  ╚═══════════════════════════════════════════════════════════════════╝

  Safe to run while both the scraper (VPS) and dashboard (PC) are writing:
  rows are MERGED, not overwritten (INSERT OR IGNORE + fill-in-blanks update).

.PARAMETER VpsHost
  SSH host string, e.g. ubuntu@123.45.67.89 or a name from ~/.ssh/config.
  Saved to deploy\vps_target.txt after first use so you don't have to repeat it.

.PARAMETER VpsAppDir
  App directory on the VPS. Default: /home/ubuntu/Desktop/virtualubuntu/puppeteer-app

.PARAMETER DbName
  Database filename to sync. Default: sportybet_archive.db

.PARAMETER Dbs
  Array of DB filenames to sync. Default: @('sportybet_archive.db')

.PARAMETER Force
  Pass -Force to auto-stash uncommitted VPS changes during git pull.

.PARAMETER SkipCode
  Skip the code update (git push + VPS git pull + pm2 reload).

.PARAMETER SkipDbSync
  Skip the database sync.

.EXAMPLE
  .\deploy\vps-sync.ps1 -VpsHost ubuntu@51.20.88.99
  .\deploy\vps-sync.ps1                              # uses saved host
  .\deploy\vps-sync.ps1 -SkipCode                    # DB sync only
  .\deploy\vps-sync.ps1 -SkipDbSync                  # code push only
  .\deploy\vps-sync.ps1 -Force                       # auto-stash VPS changes
#>
param(
    [string]$VpsHost,
    [string]$VpsAppDir = '/home/ubuntu/Desktop/virtualubuntu/puppeteer-app',
    [string[]]$Dbs = @('sportybet_archive.db'),
    [switch]$Force,
    [switch]$SkipCode,
    [switch]$SkipDbSync
)
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# ── paths ────────────────────────────────────────────────────────────
$ScriptDir    = Split-Path $MyInvocation.MyCommand.Path -Parent
$AppDir       = Split-Path $ScriptDir -Parent
$LocalDbDir   = Join-Path $AppDir 'databases'
$TargetFile   = Join-Path $ScriptDir 'vps_target.txt'
$RemoteHelper = Join-Path $ScriptDir 'vps_remote.sh'
$TmpDir       = Join-Path $env:TEMP 'vfl_sync'

# ── resolve VPS host ─────────────────────────────────────────────────
if (-not $VpsHost) {
    if (Test-Path $TargetFile) { $VpsHost = (Get-Content $TargetFile -First 1).Trim() }
    if (-not $VpsHost) {
        Write-Host "`nYou have not set up the VPS host yet.`n" -ForegroundColor Yellow
        $VpsHost = Read-Host 'Enter your VPS SSH target (e.g. ubuntu@51.20.88.99)'
        if (-not $VpsHost) { Write-Error 'No VPS host provided.'; exit 1 }
    }
}
$VpsHost | Set-Content $TargetFile -Force
Write-Host "VPS target : $VpsHost" -ForegroundColor Cyan
Write-Host "VPS app dir: $VpsAppDir" -ForegroundColor Cyan

# ── helpers ──────────────────────────────────────────────────────────
function Run-SSH([string]$cmd) {
    $out = ssh -n -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new $VpsHost $cmd 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Error "SSH failed ($LASTEXITCODE): $out" }
    return $out
}
function Send-File([string]$local, [string]$remote) { scp -o ConnectTimeout=15 -o BatchMode=yes $local "${VpsHost}:$remote" }
function Recv-File([string]$remote, [string]$local) { scp -o ConnectTimeout=15 -o BatchMode=yes "${VpsHost}:$remote" $local }

# ── connectivity check ───────────────────────────────────────────────
Write-Host "`n[1/5] Checking SSH connectivity..." -ForegroundColor White
try {
    $chk = Run-SSH "echo OK"
    if ($chk -notmatch 'OK') { throw "unexpected: $chk" }
    Write-Host "  SSH OK" -ForegroundColor Green
} catch {
    Write-Host "`n  Cannot SSH into $VpsHost." -ForegroundColor Red
    Write-Host "  Make sure you have set up SSH key login. Quick guide:" -ForegroundColor Yellow
    Write-Host "    1) ssh-keygen  (if you don't have a key yet)" -ForegroundColor Yellow
    Write-Host "    2) ssh-copy-id $VpsHost" -ForegroundColor Yellow
    Write-Host "    3) Try: ssh $VpsHost echo OK" -ForegroundColor Yellow
    exit 1
}

# ── upload helper script ─────────────────────────────────────────────
$RemoteTmp = '/tmp/vfl_vps_remote.sh'
Send-File $RemoteHelper $RemoteTmp
Run-SSH "chmod +x $RemoteTmp" | Out-Null

# ── code update ──────────────────────────────────────────────────────
if (-not $SkipCode) {
    Write-Host "`n[2/5] Committing & pushing code to VPS..." -ForegroundColor White
    Set-Location $AppDir; Set-Location (git rev-parse --show-toplevel)
    git add -A
    $dirty = git diff --cached --stat
    if ($dirty) {
        git commit -m "deploy: sync code to VPS $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
        Write-Host "  committed: $dirty"
    }
    $vpsRepoDir = ($VpsAppDir -replace '/[^/]+$', '')
    Write-Host "  pushing to VPS repo ($vpsRepoDir)..."
    git push "${VpsHost}:${vpsRepoDir}" HEAD:main 2>&1 | ForEach-Object { Write-Host "  $_" }

    try {
        $branch = (git rev-parse --abbrev-ref HEAD).Trim()
        git push origin "${branch}:main" 2>$null | Out-Null
        Write-Host "  pushed to GitHub origin/main" -ForegroundColor Green
    } catch {}

    Write-Host "`n[3/5] Updating working tree on VPS + pm2 reload..." -ForegroundColor White
    $forceArg = if ($Force) { '--force' } else { '' }
    $out = Run-SSH "bash $RemoteTmp update $VpsAppDir $forceArg"
    $out | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "`n[2/5] Code update skipped (-SkipCode)" -ForegroundColor DarkGray
    Write-Host "[3/5] Code update skipped (-SkipCode)" -ForegroundColor DarkGray
}

# ── database sync ────────────────────────────────────────────────────
if (-not $SkipDbSync) {
    New-Item -ItemType Directory $TmpDir -Force | Out-Null
    foreach ($dbName in $Dbs) {
        $localDb = Join-Path $LocalDbDir $dbName
        Write-Host "`n[4/5] DB sync: $dbName  (PC → VPS)" -ForegroundColor White
        $pcToVpsOk = $false
        if (Test-Path $localDb) {
            $pkg = Join-Path $TmpDir "pc_to_vps_$dbName.gz"
            if (Test-Path $pkg) { Remove-Item $pkg -Force }
            Write-Host "  exporting from local..."
            node (Join-Path $AppDir 'utils\db_sync_tool.js') export $localDb $pkg --peer vps --lookback-hours 6
            if ($LASTEXITCODE -eq 0 -and (Test-Path $pkg)) {
                $mb = [math]::Round((Get-Item $pkg).Length / 1MB, 2)
                Write-Host "  uploading $mb MB..."
                Send-File $pkg "/tmp/vfl_pc_pkg.gz"
                Write-Host "  merging on VPS..."
                Run-SSH "bash $RemoteTmp merge $VpsAppDir /tmp/vfl_pc_pkg.gz $dbName" | ForEach-Object { Write-Host "  $_" }
                if ($LASTEXITCODE -eq 0) {
                    node (Join-Path $AppDir 'utils\db_sync_tool.js') ack $localDb --peer vps | Out-Null
                    $pcToVpsOk = $true
                    Write-Host "  done." -ForegroundColor Green
                }
            } else {
                Write-Host "  local export failed - skipping PC → VPS upload" -ForegroundColor Red
            }
        } else {
            $pcToVpsOk = $true
            Write-Host "  local $dbName not found - skipping PC → VPS" -ForegroundColor Yellow
        }

        Write-Host "`n[5/5] DB sync: $dbName  (VPS → PC)" -ForegroundColor White
        $remotePkg = "/tmp/vfl_vps_pkg_$dbName.gz"
        $out = Run-SSH "bash $RemoteTmp export $VpsAppDir $dbName $remotePkg 6"
        if ($out -match 'NODB') {
            Write-Host "  VPS has no $dbName - skipping VPS → PC" -ForegroundColor Yellow
        } else {
            $out | ForEach-Object { Write-Host "  $_" }
            $localPkg = Join-Path $TmpDir "vps_to_pc_$dbName.gz"
            if (Test-Path $localPkg) { Remove-Item $localPkg -Force }
            Recv-File $remotePkg $localPkg
            if (Test-Path $localPkg) {
                $mb2 = [math]::Round((Get-Item $localPkg).Length / 1MB, 2)
                Write-Host "  downloaded $mb2 MB, merging locally..."
                New-Item -ItemType Directory $LocalDbDir -Force | Out-Null
                node (Join-Path $AppDir 'utils\db_sync_tool.js') merge $localPkg $localDb
                if ($LASTEXITCODE -eq 0) {
                    Run-SSH "bash $RemoteTmp ack $VpsAppDir $dbName" | Out-Null
                    if ($pcToVpsOk) {
                        node (Join-Path $AppDir 'utils\db_sync_tool.js') mark-synced $localDb --peer vps | Out-Null
                    }
                    Write-Host "  done." -ForegroundColor Green
                } else {
                    Write-Host "  local merge failed - VPS watermark NOT acked so next sync will retry" -ForegroundColor Red
                }
            }
        }
    }
} else {
    Write-Host "`n[4/5] DB sync skipped (-SkipDbSync)" -ForegroundColor DarkGray
    Write-Host "[5/5] DB sync skipped (-SkipDbSync)" -ForegroundColor DarkGray
}

# ── status ───────────────────────────────────────────────────────────
Write-Host "`n── VPS status ────────────────────────────────" -ForegroundColor Cyan
Run-SSH "bash $RemoteTmp status $VpsAppDir" | ForEach-Object { Write-Host "  $_" }
Write-Host "`nAll done.`n" -ForegroundColor Green
