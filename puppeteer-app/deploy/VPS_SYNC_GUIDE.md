# VPS Sync Guide

One-command deployment + database sync between your Windows PC and Ubuntu VPS.

---

## What it does

```
Your PC                          VPS (Ubuntu)
──────────                       ──────────────
1. git push  ──→  GitHub  ──→   git pull + npm install + pm2 reload
2. Export local DB ──→  SCP  ──→ merge into VPS DB
3. Export VPS DB   ←──  SCP  ←── merge into local DB
```

All DB merges are **incremental** and **non-destructive** — only new/updated rows transfer.

---

## First-time setup

### 1. SSH key login (do this once)

Open PowerShell on your PC:

```powershell
# Generate a key if you don't have one yet
ssh-keygen -t ed25519

# Copy your key to the VPS (replace with your actual IP/user)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh ubuntu@YOUR_VPS_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

# Test it — should print OK with no password prompt
ssh ubuntu@YOUR_VPS_IP echo OK
```

### 2. First sync run

```powershell
cd ./puppeteer-app
.\deploy\vps-sync.ps1 -VpsHost ubuntu@YOUR_VPS_IP
```

It will:
- Save your VPS target to `deploy/vps_target.txt` so you never have to type it again
- Push your code to GitHub, pull it on the VPS
- Sync databases both ways

### 3. Subsequent runs

```powershell
.\deploy\vps-sync.ps1            # uses saved host — just double-click or run this
```

---

## Command options

| Flag | What it does |
|------|-------------|
| `-VpsHost user@ip` | Set/change the VPS target |
| `-Force` | Auto-stash uncommitted VPS changes during git pull |
| `-SkipCode` | Only sync databases, don't push code |
| `-SkipDbSync` | Only push code, don't sync databases |
| `-Dbs @('sportybet_archive.db','paper_trading.db')` | Sync multiple DBs |

### Examples

```powershell
# Full sync (code + main DB)
.\deploy\vps-sync.ps1

# Sync both main DB and paper trading DB
.\deploy\vps-sync.ps1 -Dbs @('sportybet_archive.db','paper_trading.db')

# Just push code changes, skip DB
.\deploy\vps-sync.ps1 -SkipDbSync

# Just sync DBs, don't touch code
.\deploy\vps-sync.ps1 -SkipCode
```

---

## How the DB merge works

1. **Export**: Extracts rows changed in the last 6 hours (or since last ack) into a gzipped package
2. **Merge**: `INSERT OR IGNORE` for new rows + `UPDATE` to fill in blanks (scores, HT scores, status upgrades)
3. **Ack**: Marks the sync point so next export is truly incremental

This means:
- ✅ Safe to run while both sides are writing
- ✅ Never overwrites data — only fills gaps
- ✅ Incremental — after first sync, packages are tiny (~KB instead of MB)

---

## Files involved

| File | Location | Purpose |
|------|----------|---------|
| `deploy/vps-sync.ps1` | PC | Main sync script (run this) |
| `deploy/vps_remote.sh` | VPS (uploaded automatically) | Server-side helper |
| `deploy/vps_target.txt` | PC | Saved VPS host (auto-created) |
| `utils/db_sync_tool.js` | Both | DB export/merge engine |

---

## Scheduling (optional)

To run the sync automatically every 4 hours, create a Windows Task Scheduler entry:

1. Open Task Scheduler → Create Basic Task
2. Trigger: Daily, repeat every 4 hours
3. Action: Start a program
   - Program: `powershell.exe`
   - Arguments: `-ExecutionPolicy Bypass -File "./puppeteer-app\deploy\vps-sync.ps1"`
   - Start in: `./puppeteer-app`

---

## Troubleshooting

**"Cannot SSH into..."**
- Check `ssh ubuntu@YOUR_IP echo OK` works manually
- Make sure your key is in `~/.ssh/authorized_keys` on the VPS

**"git push failed"**
- Make sure you have GitHub credentials configured: `git config --global credential.helper manager`

**"NODB" during DB sync**
- The VPS doesn't have that database file yet — it'll be created on the first scraper run

**PM2 not reloading**
- SSH in manually: `ssh ubuntu@YOUR_IP "cd /home/ubuntu/Desktop/virtualubuntu/puppeteer-app && pm2 status"`
