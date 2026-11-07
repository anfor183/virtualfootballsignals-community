const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
// Legacy paper-table lifecycle is tested with independent ML bundles absent.
// Independent selection and model readiness are covered by test_adaptive_markets.
test.before(() => mock.method(require('./utils/adaptive_market_predictor'), 'loadBundle', () => null));
test.after(() => mock.restoreAll());
const { recordFuturePaperPicks, settlePaperPicks, getPaperTrackingReport } = require('./utils/paper_pick_tracker');

function fixtureDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE live_predictions (
        id INTEGER PRIMARY KEY, season_name TEXT, round_number INTEGER, home_team TEXT,
        away_team TEXT, match_time TEXT, kickoff_timestamp INTEGER, scored_status INTEGER DEFAULT 0,
        actual_score TEXT, actual_ht_score TEXT, predicted_probs TEXT, bookmaker_odds TEXT);
        CREATE TABLE ai_best_picks_history (id INTEGER PRIMARY KEY, status TEXT);
        INSERT INTO ai_best_picks_history VALUES (1, 'won');`);
    return db;
}
function addFixture(db, overrides = {}) {
    const row = { season_name: 'Sportybet England - Week 1 (test)', round_number: 1,
        home_team: 'Home', away_team: 'Away', match_time: '15:00', kickoff_timestamp: Date.now() + 600000,
        scored_status: 0, actual_score: null, actual_ht_score: null,
        predicted_probs: JSON.stringify({ homeWinProb: 60, drawProb: 25, awayWinProb: 15, over15Prob: 80 }),
        bookmaker_odds: JSON.stringify({ home: 2, dc1x: 1.3, over15: 1.2 }), ...overrides };
    db.prepare(`INSERT INTO live_predictions (season_name, round_number, home_team, away_team,
        match_time, kickoff_timestamp, scored_status, actual_score, actual_ht_score, predicted_probs, bookmaker_odds)
        VALUES (@season_name, @round_number, @home_team, @away_team, @match_time, @kickoff_timestamp,
        @scored_status, @actual_score, @actual_ht_score, @predicted_probs, @bookmaker_odds)`).run(row);
    return row;
}
// Known supported outcomes exercise the tracking lifecycle without loading the
// scraper, network clients, Telegram broadcaster, or production database.
function evaluate(market, ft, ht) {
    const [h, a] = ft.split(':').map(Number);
    if (market === '1X') return h >= a ? 'won' : 'lost';
    if (market === 'Home Win') return h > a ? 'won' : 'lost';
    if (market === 'HT/FT 1/1') return ht === '1:0' && h > a ? 'won' : 'lost';
    throw new Error('Unexpected test market: ' + market);
}

test('records before kickoff once; price and selection remain frozen; published history untouched', async () => {
    const db = fixtureDb(); const row = addFixture(db);
    assert.equal(await recordFuturePaperPicks(db, row.season_name), 2);
    const original = db.prepare('SELECT * FROM paper_pick_observations ORDER BY id').all();
    db.prepare('UPDATE live_predictions SET bookmaker_odds = ?').run('{"home":3,"dc1x":1.9}');
    assert.equal(await recordFuturePaperPicks(db, row.season_name), 0);
    assert.deepEqual(db.prepare('SELECT * FROM paper_pick_observations ORDER BY id').all(), original);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_best_picks_history').get().n, 1);
    assert.ok(original.every(p => p.recorded_at < p.kickoff_timestamp));
    db.close();
});

test('never backfills kicked-off, already-scored or undated fixtures', async () => {
    const db = fixtureDb(); const row = addFixture(db, { kickoff_timestamp: Date.now() - 1 });
    addFixture(db, { round_number: 2, scored_status: 1, actual_score: '2:0' });
    addFixture(db, { round_number: 3, kickoff_timestamp: null });
    assert.equal(await recordFuturePaperPicks(db, row.season_name), 0);
    db.close();
});

test('missing bookmaker prices never become made-up paper bets', async () => {
    const db = fixtureDb(); const row = addFixture(db, { bookmaker_odds: '{}' });
    assert.equal(await recordFuturePaperPicks(db, row.season_name), 0);
    db.close();
});

test('settles exact fixture only, even with no published pending picks; idempotent', async () => {
    const db = fixtureDb(); const row = addFixture(db);
    await recordFuturePaperPicks(db, row.season_name);
    addFixture(db, { season_name: 'another season', scored_status: 1, actual_score: '0:4' });
    assert.equal(settlePaperPicks(db, evaluate), 0);
    db.prepare('UPDATE live_predictions SET scored_status=1, actual_score=? WHERE season_name=?').run('2:0', row.season_name);
    assert.equal(settlePaperPicks(db, evaluate), 2);
    assert.equal(settlePaperPicks(db, evaluate), 0);
    const report = getPaperTrackingReport(db);
    assert.equal(report.pendingPicks, 0); assert.equal(report.settledPicks.length, 2);
    assert.ok(report.settledPicks.every(p => p.status === 'won' && p.record_source === 'paper_candidate'));
    assert.equal(db.prepare('SELECT status FROM ai_best_picks_history').get().status, 'won');
    db.close();
});

test('HT/FT observations wait for a real halftime score', async () => {
    const db = fixtureDb(); const row = addFixture(db, {
        predicted_probs: '{"htft11Prob":80}', bookmaker_odds: '{"htft":{"htft11":2.5}}' });
    await recordFuturePaperPicks(db, row.season_name);
    db.exec("UPDATE live_predictions SET scored_status=1, actual_score='2:0'");
    assert.equal(settlePaperPicks(db, evaluate), 0);
    db.exec("UPDATE live_predictions SET actual_ht_score='1:0'");
    assert.equal(settlePaperPicks(db, evaluate), 2);
    db.close();
});

test('reports on old databases are read-only and return an explicit empty state', () => {
    const db = fixtureDb();
    assert.equal(getPaperTrackingReport(db).available, false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='paper_pick_observations'").get().n, 0);
    db.close();
});
