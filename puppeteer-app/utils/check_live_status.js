const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'databases', 'sportybet_archive.db');
const db = new Database(dbPath);

const liveCount = db.prepare("SELECT count(1) as count FROM live_predictions").get().count;
const picksCount = db.prepare("SELECT count(1) as count FROM ai_best_picks_history").get().count;

console.log('=== Fresh Database Status ===');
console.log('Total live_predictions in DB:', liveCount);
console.log('Total ai_best_picks_history in DB:', picksCount);

const rounds = db.prepare(`
    SELECT round_number, count(1) as matches, min(match_time) as first_match_time,
           datetime(min(kickoff_timestamp)/1000, 'unixepoch') as first_kickoff_utc
    FROM live_predictions
    GROUP BY round_number
    ORDER BY round_number ASC
`).all();
console.log('=== Live Predictions Rounds ===');
console.table(rounds);

if (picksCount > 0) {
    const summary = db.prepare("SELECT pick_type, status, count(1) as total FROM ai_best_picks_history GROUP BY pick_type, status").all();
    console.log('=== Picks Summary ===');
    console.table(summary);

    const latest = db.prepare("SELECT id, round_number, pick_type, market, home_team, away_team, status, kickoff_timestamp FROM ai_best_picks_history ORDER BY id DESC LIMIT 10").all();
    console.log('=== Latest Picks ===');
    console.table(latest);
} else {
    console.log('Awaiting next scraper scrape cycle to populate upcoming rounds.');
}
db.close();
