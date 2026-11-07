'use strict';

// Separate storage: these rows must never enter the publication/Telegram pipeline.
function ensurePaperTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS paper_pick_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        season_name TEXT NOT NULL, round_number INTEGER NOT NULL, pick_type TEXT NOT NULL,
        home_team TEXT NOT NULL, away_team TEXT NOT NULL, market TEXT NOT NULL,
        probability REAL NOT NULL, implied_odd REAL NOT NULL,
        kickoff_timestamp INTEGER NOT NULL, match_time TEXT,
        recorded_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        actual_score TEXT, actual_ht_score TEXT, settled_at INTEGER,
        UNIQUE(season_name, round_number, pick_type)
    ); CREATE INDEX IF NOT EXISTS idx_paper_pick_status ON paper_pick_observations(status);`);
}

async function recordFuturePaperPicks(db, seasonName, now = Date.now()) {
    ensurePaperTable(db);
    const { buildPaperCandidates } = await import('./paper_pick_candidates.mjs');
    const matches = db.prepare(`SELECT * FROM live_predictions
        WHERE season_name = ? AND scored_status = 0 AND actual_score IS NULL
          AND kickoff_timestamp > ? AND round_number IS NOT NULL
        ORDER BY kickoff_timestamp, id`).all(seasonName, now);
    const rounds = new Map();
    for (const match of matches) {
        if (!rounds.has(match.round_number)) rounds.set(match.round_number, []);
        rounds.get(match.round_number).push(match);
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO paper_pick_observations (
        season_name, round_number, pick_type, home_team, away_team, market, probability,
        implied_odd, kickoff_timestamp, match_time, recorded_at
    ) VALUES (@season_name, @round_number, @pick_type, @home_team, @away_team, @market,
        @probability, @implied_odd, @kickoff_timestamp, @match_time, @recorded_at)`);
    let recorded = 0;
    db.transaction(() => {
        for (const roundMatches of rounds.values()) {
            for (const pick of Object.values(buildPaperCandidates(roundMatches))) {
                // Recheck the clock after candidate calculation: no retrospective picks.
                if (!pick || pick.kickoff_timestamp <= Math.max(now, Date.now())) continue;
                if (pick.pick_type === 'safest' && require('./adaptive_market_predictor').loadBundle('safest')) continue;
                recorded += insert.run({ ...pick, match_time: pick.match_time || null, recorded_at: Math.max(now, Date.now()) }).changes;
            }
        }
    })();
    return recorded;
}

function hasPaperTable(db) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_pick_observations'").get();
}

function settlePaperPicks(db, evaluatePickOutcome, now = Date.now()) {
    if (!hasPaperTable(db)) return 0;
    // Exact fixture identity prevents the same team pairing in another round/league
    // from settling a paper observation. Missing HT scores remain unresolved.
    const pending = db.prepare(`SELECT p.id, p.market, lp.actual_score, lp.actual_ht_score
        FROM paper_pick_observations p JOIN live_predictions lp
          ON lp.season_name = p.season_name AND lp.round_number = p.round_number
         AND lp.home_team = p.home_team AND lp.away_team = p.away_team
         AND lp.kickoff_timestamp = p.kickoff_timestamp
        WHERE p.status = 'pending' AND lp.scored_status = 1 AND lp.actual_score IS NOT NULL`).all();
    const update = db.prepare(`UPDATE paper_pick_observations SET status = ?, actual_score = ?,
        actual_ht_score = ?, settled_at = ? WHERE id = ? AND status = 'pending'`);
    let settled = 0;
    db.transaction(() => {
        for (const pick of pending) {
            if (!/^\d+:\d+$/.test(pick.actual_score)) continue;
            if (pick.market.startsWith('HT/FT ') && !/^\d+:\d+$/.test(pick.actual_ht_score || '')) continue;
            const status = evaluatePickOutcome(pick.market, pick.actual_score, pick.actual_ht_score);
            if (status === 'won' || status === 'lost') {
                settled += update.run(status, pick.actual_score, pick.actual_ht_score, now, pick.id).changes;
            }
        }
    })();
    return settled;
}

function observationSql(db) {
    const legacy = hasPaperTable(db);
    const ml = require('./adaptive_market_observer').exists(db);
    if (!legacy && !ml) return null;
    const columns = 'season_name,round_number,home_team,away_team,market,probability,implied_odd,kickoff_timestamp,match_time,recorded_at,status,actual_score';
    const parts = [];
    if (legacy) parts.push(`SELECT id,pick_type,${columns}, 'paper_candidate' AS record_source FROM paper_pick_observations p
        ${ml ? "WHERE NOT EXISTS (SELECT 1 FROM ml_pick_observations m WHERE ((m.engine='safest' AND p.pick_type='safest') OR (m.engine='high_chance' AND p.pick_type='high_value')) AND m.season_name=p.season_name AND m.round_number=p.round_number)" : ''}`);
    if (ml) parts.push(`SELECT -id AS id,CASE engine WHEN 'ai_best' THEN 'ai_best_pick' WHEN 'high_chance' THEN 'high_value' ELSE engine END AS pick_type,
        ${columns}, 'ml_shadow' AS record_source FROM ml_pick_observations`);
    return parts.join(' UNION ALL ');
}
function getPaperTrackingReport(db) {
    const source = observationSql(db);
    if (!source) return { available: false, totalPicks: 0, pendingPicks: 0, settledPicks: [] };
    const summary = db.prepare(`SELECT COUNT(*) AS totalPicks, COALESCE(SUM(status='pending'),0) AS pendingPicks,
        MIN(recorded_at) AS trackingStartedAt, MAX(recorded_at) AS lastRecordedAt FROM (${source})`).get();
    const settledPicks = db.prepare(`SELECT * FROM (${source}) WHERE status IN ('won','lost') ORDER BY kickoff_timestamp,id`).all();
    const trackingRun = require('./tracking_run').activeRun(db);
    let newSystem = { totalPicks: 0, pendingPicks: 0, settledPicks: [] };
    if (trackingRun) {
        const fresh = `SELECT * FROM (${source}) WHERE record_source='ml_shadow' AND pick_type NOT IN ('market_specialist','over35','under35') AND recorded_at>=?`;
        const stats = db.prepare(`SELECT COUNT(*) totalPicks,COALESCE(SUM(status='pending'),0) pendingPicks FROM (${fresh})`).get(trackingRun.started_at);
        newSystem = { ...stats, settledPicks: db.prepare(`${fresh} AND status IN ('won','lost') ORDER BY kickoff_timestamp,id`).all(trackingRun.started_at),
            pendingRows: db.prepare(`${fresh} AND status='pending' ORDER BY kickoff_timestamp,id`).all(trackingRun.started_at) };
    }
    const pendingRows = db.prepare(`SELECT * FROM (${source}) WHERE status='pending' ORDER BY kickoff_timestamp,id`).all();
    return { available: true, ...summary, settledPicks, pendingRows, trackingRun, newSystem,
        goalsEngine:require('./goals_engine').report(db) };
}
function getPendingPaperPicks(db) {
    const source = observationSql(db);
    return source ? db.prepare(`SELECT * FROM (${source}) WHERE status='pending' AND kickoff_timestamp > ?
        ORDER BY kickoff_timestamp,id LIMIT 100`).all(Date.now()) : [];
}

module.exports = { recordFuturePaperPicks, settlePaperPicks, getPaperTrackingReport, getPendingPaperPicks };
