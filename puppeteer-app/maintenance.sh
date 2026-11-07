#!/usr/bin/env bash
set -e

APP_DIR="/home/ubuntu/Desktop/virtualubuntu/puppeteer-app"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"

echo "========================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Tight 24/7 Memory Maintenance"
echo "========================================================"

# 1. Clean stale Chromium, Puppeteer temporary profiles & dead X display locks
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 1. Cleaning temporary Chromium profiles and dead X display locks..."
find /tmp -maxdepth 1 -type d \( -name "lighthouse.*" -o -name "puppeteer_dev_*" -o -name ".org.chromium.*" -o -name ".com.google.Chrome.*" \) -mmin +120 -exec rm -rf {} + 2>/dev/null || true

# Clean up stale X11 lock files and sockets where the owning process is dead (prevents false display detection)
for lock in /tmp/.X*-lock; do
    [ -f "$lock" ] || continue
    lpid=$(cat "$lock" 2>/dev/null | tr -d ' ')
    if [ -n "$lpid" ] && ! kill -0 "$lpid" 2>/dev/null; then
        dnum="${lock#/tmp/.X}"
        dnum="${dnum%-lock}"
        echo "   ↳ Removing stale X lock and socket for display :${dnum} (PID ${lpid} dead)"
        rm -f "$lock" "/tmp/.X11-unix/X${dnum}"
    fi
done

# 2. Reclaim Linux Kernel page caches & dentries
sudo sync
echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null 2>&1 || true
echo "   ↳ Temp directory and kernel cache cleanup completed."

# 3. Network & VPN Resilience Check
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 3. Checking VPN and network connectivity..."
if ! ping -I tun0 -c 2 -W 3 1.1.1.1 >/dev/null 2>&1; then
    echo "   ⚠️ Internet connection down or VPN unresponsive. Attempting VPN reconnect..."
    sudo nmcli connection up "ProtonVPN CA-FREE#27" 2>/dev/null || true
else
    echo "   ✅ Network connectivity is healthy."
fi

# 4. Database Maintenance (Integrity Check & VACUUM)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 4. Running SQLite diagnostics and optimization..."
if [ -f "$APP_DIR/diagnose_database.js" ]; then
    node "$APP_DIR/diagnose_database.js" || true
    echo "   ↳ Database diagnostics completed."
fi

# 5. Graceful Process Reload & Health Check
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 5. Checking PM2 process status..."
if command -v pm2 >/dev/null 2>&1; then
    if pm2 list | grep -q "vfl-scraper"; then
        echo "   ↳ Gracefully reloading vfl-scraper to reset memory allocations..."
        pm2 reload vfl-scraper --update-env || pm2 restart vfl-scraper
        echo "   ✅ vfl-scraper reloaded successfully."
    else
        echo "   ℹ️ PM2 vfl-scraper is not running; skipping process reload."
    fi

    if pm2 list | grep -q "bot-dashboard"; then
        status=$(pm2 jlist | node -e '
            const list = JSON.parse(require("fs").readFileSync(0, "utf-8"));
            const bot = list.find(p => p.name === "bot-dashboard");
            console.log(bot ? bot.pm2_env.status : "unknown");
        ' 2>/dev/null || echo "unknown")
        if [ "$status" != "online" ]; then
            echo "   ⚠️ bot-dashboard is in status: $status. Restarting..."
            pm2 restart bot-dashboard
        else
            echo "   ✅ bot-dashboard is healthy and online."
        fi
    fi
fi

echo "========================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Maintenance Finished Successfully."
echo "========================================================"
