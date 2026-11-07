param (
    [switch]$NoPause = $false
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "      BOT AUTO-INSTALLER WIZARD         " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Check for Node.js
Write-Host "`n[1/3] Checking for Node.js..." -ForegroundColor Yellow
$nodeInstalled = $false

try {
    $nodeVersion = node -v 2>$null
    if ($LASTEXITCODE -eq 0 -or $? -eq $true) {
        $nodeInstalled = $true
        Write-Host "Node.js is already installed: $nodeVersion" -ForegroundColor Green
    }
} catch {
    $nodeInstalled = $false
}

if (-not $nodeInstalled) {
    Write-Host "Node.js not found. Downloading the Node.js v20 LTS installer..." -ForegroundColor Yellow
    $nodeMsi = "$env:TEMP\nodejs-lts.msi"
    
    try {
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.14.0/node-v20.14.0-x64.msi" -OutFile $nodeMsi
        
        Write-Host "Installing Node.js silently... Please wait, this may take a few minutes." -ForegroundColor Yellow
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$nodeMsi`" /qn /norestart" -Wait -NoNewWindow -PassThru
        
        if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3010) {
            Write-Host "Node.js installed successfully!" -ForegroundColor Green
        } else {
            Write-Host "Node.js installer exited with code: $($process.ExitCode). Continuing anyway..." -ForegroundColor Red
        }
        
        # Refresh Path
        Write-Host "Refreshing Environment Variables..." -ForegroundColor Yellow
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = $machinePath + ";" + $userPath
        
        # Verify
        $nodeVersion = node -v 2>$null
        Write-Host "New Node Version: $nodeVersion" -ForegroundColor Green
    } catch {
        Write-Host "Failed to download or install Node.js: $_" -ForegroundColor Red
        Write-Host "Please install Node.js manually from https://nodejs.org and try again." -ForegroundColor Red
        if (-not $NoPause) { pause }
        exit 1
    }
}

# 2. Install Root Dependencies
Write-Host "`n[2/3] Installing Root Project Dependencies..." -ForegroundColor Yellow
if (Test-Path "package.json") {
    # We use cmd /c so we don't have to worry about PowerShell alias conflicts with npm
    cmd /c "npm install"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Root dependencies installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "Warning: npm install in root folder encountered errors." -ForegroundColor Red
    }
} else {
    Write-Host "No package.json found in root, skipping." -ForegroundColor Cyan
}

# 3. Install Dashboard Dependencies
Write-Host "`n[3/3] Installing Dashboard Dependencies..." -ForegroundColor Yellow
if (Test-Path "dashboard\package.json") {
    Push-Location "dashboard"
    cmd /c "npm install"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Dashboard dependencies installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "Warning: npm install in dashboard folder encountered errors." -ForegroundColor Red
    }
    Pop-Location
} else {
    Write-Host "Dashboard folder not found, skipping." -ForegroundColor Cyan
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "           SETUP COMPLETE!              " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "You can now run the bot by double-clicking 'run-dashboard.bat'." -ForegroundColor Yellow

if (-not $NoPause) {
    Write-Host "`nPress any key to exit..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
