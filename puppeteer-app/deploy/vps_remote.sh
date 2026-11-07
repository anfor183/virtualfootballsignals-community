#!/usr/bin/env bash
# deploy/vps_remote.sh - helper executed ON THE VPS by deploy/vps-sync.ps1 (copied to /tmp on every run).
#
#   bash vps_remote.sh check   <APP_DIR>
#   bash vps_remote.sh update  <APP_DIR> [--force]      git pull + npm install (if needed) + pm2 reload
#   bash vps_remote.sh merge   <APP_DIR> <pkg.gz> <db-file-name>
#   bash vps_remote.sh export  <APP_DIR> <db-file-name> <out.gz> [lookback-hours]
#   bash vps_remote.sh ack     <APP_DIR> <db-file-name>
#   bash vps_remote.sh status  <APP_DIR>
set -euo pipefail

CMD="${1:?command missing}"
APP_DIR="${2:?app dir missing}"
shift 2

# Make node / npm / pm2 available in a non-interactive SSH session (nvm or system installs)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; fi
export PATH="$PATH:/usr/local/bin:/usr/bin:$HOME/.npm-global/bin"

[ -d "$APP_DIR" ] || { echo "ERROR: app dir not found: $APP_DIR"; exit 2; }
cd "$APP_DIR"

online_pm2_apps() {
    pm2 jlist 2>/dev/null | node -e '
        const OWN = new Set(["vfl-scraper", "bot-dashboard", "ai-trainer", "google-sync", "sporty-api"]);
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            try { JSON.parse(s).filter(p => OWN.has(p.name) && p.pm2_env.status === "online").forEach(p => console.log(p.name)); } catch (_) {}
        });' || true
}

case "$CMD" in
check)
    echo "host      : $(hostname)"
    echo "node      : $(command -v node || echo MISSING) $(node -v 2>/dev/null || true)"
    echo "pm2       : $(command -v pm2 || echo MISSING)"
    echo "git       : $(command -v git || echo MISSING)"
    if git rev-parse --show-toplevel >/dev/null 2>&1; then
        echo "repo      : $(git rev-parse --show-toplevel) @ $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
        echo "remote    : $(git remote get-url origin 2>/dev/null || echo none)"
        echo "dirty     : $(git status --porcelain --untracked-files=no | wc -l) tracked file(s) modified"
    else
        echo "repo      : NOT A GIT CLONE"
    fi
    ls -la databases/*.db 2>/dev/null || echo "databases : none found"
    ;;

update)
    FORCE="${1:-}"
    if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
        echo "ERROR: $APP_DIR is not a git clone. See deploy/VPS_SYNC_GUIDE.md -> 'VPS is not a git clone'."
        exit 5
    fi
    REPO="$(git rev-parse --show-toplevel)"
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    OLD="$(git rev-parse HEAD)"
    git fetch --quiet origin "$BRANCH" 2>/dev/null || true
    STASHED=0
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        git stash push -m "trainer-auto-$(date +%s)" >/dev/null 2>&1 && STASHED=1 || true
    fi
    if git rev-parse --verify main >/dev/null 2>&1 && [ "$(git rev-parse main)" != "$OLD" ]; then
        git merge main --no-edit >/dev/null 2>&1 || git merge --ff-only main >/dev/null 2>&1 || true
    elif git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
        git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || true
    fi
    if [ "$STASHED" -eq 1 ]; then
        git stash pop >/dev/null 2>&1 || true
    fi
    NEW="$(git rev-parse HEAD)"
    if [ "$OLD" = "$NEW" ]; then
        echo "Code already up to date at $(git rev-parse --short HEAD)."
    else
        echo "Code updated $(git rev-parse --short "$OLD") -> $(git rev-parse --short "$NEW"):"
        git log --oneline "$OLD..$NEW" | head -20
        CHANGED="$(git diff --name-only "$OLD" "$NEW")"
        REL="$(realpath --relative-to="$REPO" "$APP_DIR")"
        if echo "$CHANGED" | grep -qx "$REL/package.json"; then
            echo "package.json changed -> npm install"
            npm install --omit=dev --no-audit --no-fund
        fi
        if echo "$CHANGED" | grep -q "^$REL/dashboard/package.json$"; then
            echo "dashboard/package.json changed -> npm install in dashboard"
            (cd dashboard && npm install --no-audit --no-fund)
        fi
        if echo "$CHANGED" | grep -q "^$REL/dashboard/src/"; then
            echo "Dashboard source changed -> rebuilding dashboard (cd dashboard && npm run build)..."
            (cd dashboard && npm run build)
        fi
    fi
    if command -v pm2 >/dev/null 2>&1; then
        if [ "$OLD" != "$NEW" ]; then
            for app in $(online_pm2_apps); do
                echo "pm2 reload $app"
                pm2 reload "$app" --update-env >/dev/null || pm2 restart "$app" >/dev/null || true
            done
        fi
        if pm2 describe htdraw-paper >/dev/null 2>&1; then
            echo "Removing retired htdraw-paper process from pm2"
            pm2 delete htdraw-paper >/dev/null 2>&1 || true
        fi
        pm2 save >/dev/null 2>&1 || true
        pm2 list
    else
        echo "WARNING: pm2 not found - restart the bot manually."
    fi
    ;;

merge)
    PKG="${1:?package}"; DB="${2:?db name}"
    node utils/db_sync_tool.js merge "$PKG" "databases/$DB"
    rm -f "$PKG"
    ;;

export)
    DB="${1:?db name}"; OUT="${2:?out}"; LB="${3:-6}"
    if [ ! -f "databases/$DB" ]; then echo "NODB"; exit 0; fi
    node utils/db_sync_tool.js export "databases/$DB" "$OUT" --peer pc --lookback-hours "$LB"
    ;;

ack)
    node utils/db_sync_tool.js ack "databases/${1:?db name}" --peer pc
    ;;

status)
    git log -1 --format='code      : %h %s (%cr)' 2>/dev/null || true
    for f in databases/*.db; do
        [ -f "$f" ] || continue
        echo "== $f ($(du -h "$f" | cut -f1))"
        node utils/db_sync_tool.js info "$f" | tail -n 3
    done
    command -v pm2 >/dev/null 2>&1 && pm2 list || true
    ;;

*)
    echo "unknown command: $CMD"; exit 2 ;;
esac
