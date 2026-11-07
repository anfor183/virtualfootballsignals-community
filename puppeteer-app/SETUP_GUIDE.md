# Bet9ja & Sportybet Live Predictor - Setup & Troubleshooting Guide

## Quick Start

### 1. **First Time Installation**
```bash
npm install
```

### 2. **Launch Dashboard**
```bash
npm start
```

The dashboard will open at `http://localhost:5173` with the Electron app.

### 3. **Configure Database**
- Go to **Settings** tab
- Set **Output Directory** to where you want database files stored
- Click **Save Settings**

### 4. **Enable Auto-Scraping**
- Go to **Live Season** or **SportyBet Live** tab
- Select your database
- Click **Auto-Scrape Toggle** to enable automatic scraping
- The system will continuously fetch new predictions and update the market history

---

## Features

### ✅ Market History Auto-Refresh
When auto-scraping is enabled:
- Market history automatically refreshes every **30 seconds** while the modal is open
- Updates automatically after each successful scrape
- Shows latest predictions and scores

### ✅ Connection Error Handling
The system now handles connection errors gracefully:
- **30-second timeout** on database queries (prevents hanging)
- **Automatic retry** on connection failures (up to 2 retries)
- **Helpful error messages** with solutions

### ✅ Runs Independently
Everything runs locally without external dependencies:
- Browser automation (Puppeteer/Playwright)
- SQLite database (built-in)
- No APIs or external services required
- Works offline after initial setup

---

## Troubleshooting

### ❌ "ECONNECT" Error
**What it means:** Database connection failed, file may be locked or corrupt.

**Solutions:**
1. **Close other connections** - Make sure no other apps are using the database
2. **Restart the app** - Fresh connection usually fixes it
3. **Check file permissions** - Ensure the database file has read/write permissions
4. **Use a new database** - Create a fresh database if the file is corrupt

### ❌ Market History Not Updating
**Solutions:**
1. Verify **Auto-Scrape is ON** - Check the toggle in the Live Season tab
2. Open the **Market History modal** - Auto-refresh only happens when modal is open
3. Wait 30 seconds - Auto-refresh runs every 30 seconds
4. Click **Sync Market History** button to force immediate update

### ❌ Scraper Stops Unexpectedly
**Reasons:**
- Browser crashed or lost connection
- Database locked by another process
- Network timeout

**Solutions:**
1. Check browser logs in the terminal
2. Close other database connections
3. Restart auto-scraping
4. The system will automatically restart after 10 seconds (auto-restart feature)

### ❌ Database File Locked
**Symptoms:** Cannot query database, "database is locked" error

**Solutions:**
```bash
# Option 1: Restart the app completely
# Option 2: Check if another process is using the file
# On Windows:
Get-Process | Where-Object {$_.ProcessName -like "*node*"}

# Option 3: Use a different database file temporarily
# In Settings, change the output directory
```

### ❌ Slow Response / Timeout
**Solutions:**
1. Ensure stable internet connection
2. Check if database file is very large (>1GB)
3. Use a fresh database if current one is corrupted
4. Close unnecessary background apps

---

## Performance Tips

### 🚀 Optimize Scraping
- **Headless Mode**: OFF for first run (helps debug issues)
- **Auto-Scrape Interval**: Default 3 minutes (adjust in settings)
- **Database**: Use SSD for faster queries

### 🗄️ Database Management
- Periodically backup your database
- Archive old predictions to a separate file
- Monitor database size (Settings → DB Info)

### 🖥️ Hardware Requirements
- **CPU**: 2+ cores recommended
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 5GB+ for database growth
- **Network**: Stable 5+ Mbps connection

---

## Advanced Configuration

### Environment Variables (Optional)
Create a `.env` file in the root directory:
```
HEADLESS_MODE=true
AUTO_SCRAPE_INTERVAL=3
DATABASE_PATH=./databases
LOG_LEVEL=debug
```

### Database Backup
```bash
# Backup current database
cp databases/virtual_football_archive.db databases/backup_$(date +%Y%m%d_%H%M%S).db

# Archive old predictions
# Run the archive script from Utilities tab in dashboard
```

### Custom Profiles
- Create browser profiles in `profiles/` directory
- Use them for A/B testing different scraping behaviors
- Each profile maintains separate cookies and settings

---

## System Architecture

```
puppeteer-app/
├── dashboard/                 # Electron app (frontend/backend)
│   ├── src/main/             # Main process (IPC handlers)
│   ├── src/renderer/          # React UI
│   └── src/                   # Built files
├── utils/                     # Scraping & ML modules
│   ├── live_companion.js      # Bet9ja scraper
│   ├── live_companion_sporty.js # SportyBet scraper
│   ├── ml_predictor.js        # ML predictions
│   └── db_*.js                # Database operations
├── databases/                 # SQLite databases
│   ├── virtual_football_archive.db
│   └── sportybet_archive.db
└── config.js                  # Shared configuration
```

---

## Database Schema

### live_predictions
Stores live predictions for upcoming matches
```sql
CREATE TABLE live_predictions (
    id INTEGER PRIMARY KEY,
    season_name TEXT,
    round_number INTEGER,
    match_time TEXT,
    home_team TEXT,
    away_team TEXT,
    predicted_result TEXT,
    predicted_probs TEXT (JSON),
    actual_score TEXT,
    actual_ht_score TEXT,
    scored_status INTEGER,
    kickoff_timestamp INTEGER
);
```

### historical_market_predictions
Stores historical data for market analysis
```sql
CREATE TABLE historical_market_predictions (
    id INTEGER PRIMARY KEY,
    season_name TEXT,
    home_team TEXT,
    away_team TEXT,
    predicted_probs TEXT (JSON),
    actual_score TEXT,
    kickoff_timestamp INTEGER
);
```

### ai_best_picks_history
Tracks AI high-risk picks
```sql
CREATE TABLE ai_best_picks_history (
    id INTEGER PRIMARY KEY,
    season_name TEXT,
    round_number INTEGER,
    pick_type TEXT,
    home_team TEXT,
    away_team TEXT,
    market TEXT,
    probability INTEGER,
    implied_odd REAL,
    status TEXT
);
```

---

## Performance Monitoring

### Check Database Health
- Go to **Settings** → **Database Info**
- Monitor table sizes and row counts
- Archive old data if database grows >500MB

### Monitor Scraper Status
- Watch the **Live Session** tab for status updates
- Check **Telegram Integration** for notifications
- View **Logs** in browser console (F12)

### Network Diagnostics
```bash
# Test connection to Bet9ja
curl -I https://st-cdn001.akamaized.net/bet9javirtuals/en/1

# Test connection to Sportybet
curl -I https://sportybet.com
```

---

## Support & Issues

### Reporting Bugs
Include:
1. Error message (full text)
2. Steps to reproduce
3. Database size (Settings → DB Info)
4. Browser/OS version
5. Recent logs (Ctrl+Shift+K)

### Getting Help
- Check **Troubleshooting** section above
- Review **Known Issues** in dashboard
- Check application logs in terminal

---

## Version History

### v2.0.0 (Current)
✅ Market history auto-refresh when auto-scraping\n✅ ECONNECT error handling with retries\n✅ 30-second database timeouts\n✅ Auto-restart on scraper failure\n✅ Improved error messages

### v1.9.0
- Initial stable release
- Manual market history refresh
- Basic error handling

---

**Last Updated:** June 2026  
**Stable:** Yes ✅  
**Ready for Production:** Yes ✅
