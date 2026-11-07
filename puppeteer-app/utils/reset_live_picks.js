const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const appDir = path.resolve(__dirname, '..');
const sportyDbPath = path.join(appDir, 'databases', 'sportybet_archive.db');
const paperDbPath = path.join(appDir, 'databases', 'paper_trading.db');

const timestamp = Date.now();

console.log(`[Reset] Starting live picks & analytics reset at ${new Date(timestamp).toISOString()}`);

// 1. Safety Backups
if (fs.existsSync(sportyDbPath)) {
    const backupPath = `${sportyDbPath}.backup_${timestamp}`;
    fs.copyFileSync(sportyDbPath, backupPath);
    console.log(`[Backup] sportybet_archive.db backed up to ${path.basename(backupPath)} (${(fs.statSync(backupPath).size / (1024*1024)).toFixed(2)} MB)`);
}

if (fs.existsSync(paperDbPath)) {
    const backupPath = `${paperDbPath}.backup_${timestamp}`;
    fs.copyFileSync(paperDbPath, backupPath);
    console.log(`[Backup] paper_trading.db backed up to ${path.basename(backupPath)} (${(fs.statSync(backupPath).size / (1024*1024)).toFixed(2)} MB)`);
}

// 2. Clear sportybet_archive.db live prediction and pick tables
if (fs.existsSync(sportyDbPath)) {
    const db = new Database(sportyDbPath);
    db.pragma('journal_mode = WAL');

    const tablesToClear = [
        'ai_best_picks_history',
        'live_predictions',
        'paper_pick_observations',
        'ml_pick_observations',
        'ml_policy_observations',
        'market_specialist_decisions',
        'goals35_candidates',
        'goals35_decisions',
        'goals_market_candidates',
        'goals_engine_decisions',
        'tracking_runs'
    ];

    for (const table of tablesToClear) {
        try {
            const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            if (tableExists) {
                const countBefore = db.prepare(`SELECT count(1) as count FROM ${table}`).get().count;
                db.prepare(`DELETE FROM ${table}`).run();
                console.log(`[Reset] Cleared table ${table} (${countBefore} rows removed)`);
            }
        } catch (err) {
            console.error(`[Reset] Error clearing ${table}:`, err.message);
        }
    }

    // Verify fixtures preserved
    try {
        const fixtureCount = db.prepare("SELECT count(1) as count FROM sporty_fixtures").get().count;
        console.log(`[Verify] sporty_fixtures preserved: ${fixtureCount} historical matches intact.`);
    } catch (_) {}

    db.close();
}

// 3. Clear paper_trading.db
if (fs.existsSync(paperDbPath)) {
    const db = new Database(paperDbPath);
    db.pragma('journal_mode = WAL');

    const paperTables = ['paper_bets', 'paper_meta'];
    for (const table of paperTables) {
        try {
            const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            if (tableExists) {
                const countBefore = db.prepare(`SELECT count(1) as count FROM ${table}`).get().count;
                db.prepare(`DELETE FROM ${table}`).run();
                console.log(`[Reset] Cleared table ${table} (${countBefore} rows removed)`);
            }
        } catch (err) {
            console.error(`[Reset] Error clearing ${table}:`, err.message);
        }
    }
    db.close();
}

console.log('[Reset] Live picks & analytics reset complete. Scraped historical fixtures preserved.');
