const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveDatabasePath } = require('./utils/path_resolver');

const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
    SELECT h.id, h.actual_ht_score, h.actual_score, h.predicted_probs,
           lp.bookmaker_odds, h.home_team, h.away_team
    FROM historical_market_predictions h
    JOIN live_predictions lp ON lp.home_team = h.home_team AND lp.away_team = h.away_team
    WHERE h.actual_ht_score IS NOT NULL
      AND lp.bookmaker_odds IS NOT NULL
      AND lp.bookmaker_odds LIKE '%htft11%'
    GROUP BY h.id
    ORDER BY h.id ASC
    LIMIT 5000
`).all();

const out = rows.map(r => {
    let probs = {};
    try { probs = JSON.parse(r.predicted_probs || '{}'); } catch(e) {}
    let bookOdds = {};
    try { bookOdds = (JSON.parse(r.bookmaker_odds || '{}')).htft || {}; } catch(e) {}
    const hH = parseInt(r.actual_ht_score.split(':')[0]);
    const hA = parseInt(r.actual_ht_score.split(':')[1]);
    const fH = parseInt(r.actual_score.split(':')[0]);
    const fA = parseInt(r.actual_score.split(':')[1]);
    const ht = hH>hA?'1':hH<hA?'2':'X';
    const ft = fH>fA?'1':fH<fA?'2':'X';
    return { label: 'htft'+ht+ft, bookOdds, probs };
}).filter(r => r.label && Object.keys(r.bookOdds).length > 0);

const outPath = path.join(os.tmpdir(), 'hmp_with_odds.json');
fs.writeFileSync(outPath, JSON.stringify(out));
process.stderr.write('Exported ' + out.length + ' rows to ' + outPath + '\n');
db.close();
