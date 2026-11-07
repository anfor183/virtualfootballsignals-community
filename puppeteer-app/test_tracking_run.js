const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {startRun,activeRun}=require('./utils/tracking_run');
const {getPaperTrackingReport}=require('./utils/paper_pick_tracker');
test('new tracking period starts from zero and preserves archived history and training fixtures',()=>{
    const db=new Database(':memory:');
    db.exec(`CREATE TABLE ai_best_picks_history(id INTEGER PRIMARY KEY,status TEXT);
        INSERT INTO ai_best_picks_history VALUES(208,'won');
        CREATE TABLE live_predictions(id INTEGER,actual_score TEXT);INSERT INTO live_predictions VALUES(1,'2:0');
        CREATE TABLE ml_pick_observations(id INTEGER PRIMARY KEY,engine TEXT,season_name TEXT,round_number INTEGER,
          home_team TEXT,away_team TEXT,market TEXT,probability REAL,implied_odd REAL,kickoff_timestamp INTEGER,
          match_time TEXT,recorded_at INTEGER,status TEXT,actual_score TEXT);
        INSERT INTO ml_pick_observations VALUES(1,'safest','S',1,'A','B','1X',90,1.1,100,'00:00',99,'won','2:0');`);
    const run=startRun(db,{startedAt:200});assert.equal(run.published_after_id,208);
    let report=getPaperTrackingReport(db);assert.equal(report.settledPicks.length,1);
    assert.equal(report.newSystem.totalPicks,0);assert.equal(report.trackingRun.started_at,200);
    db.exec("INSERT INTO ml_pick_observations VALUES(2,'high_chance','S',2,'C','D','Over 2.5 Goals',80,1.9,400,'00:00',201,'lost','0:0')");
    report=getPaperTrackingReport(db);assert.equal(report.newSystem.totalPicks,1);
    assert.equal(report.newSystem.settledPicks[0].pick_type,'high_value');
    assert.equal(db.prepare('SELECT count(*) n FROM live_predictions').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM ai_best_picks_history').get().n,1);
    assert.equal(activeRun(db).id,run.id);db.close();
});
