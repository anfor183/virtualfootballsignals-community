const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const specialist=require('./utils/market_specialist');
const {startRun,resetRun}=require('./utils/tracking_run');
const now=Date.now();
const historical=(i,extra={})=>({id:i,engine:'high_chance',season_name:'Sportybet England - Week '+i,round_number:i,
 home_team:'H'+i,away_team:'A'+i,market:'Over 2.5 Goals',status:i%3?'won':'lost',implied_odd:2.1,
 recorded_at:now-1e7+i*1000-100,kickoff_timestamp:now-1e7+i*1000,...extra});
function fixture(extra={}) {return {id:1,season_name:'Sportybet England - Week 99',round_number:99,home_team:'Home',away_team:'Away',
 kickoff_timestamp:now+600000,match_time:'15:00',predicted_probs:JSON.stringify({homeWinProb:40,drawProb:30,awayWinProb:30,over25Prob:60}),
 bookmaker_odds:JSON.stringify({home:2.6,draw:3.3,away:3.4,over25:2.1,under25:1.7}),...extra};}
test('market learner deduplicates correlated engine choices and excludes future, late, other-league outcomes',()=>{
 const rows=Array.from({length:30},(_,i)=>historical(i));
 const expected=specialist.profiles(rows,now,'sportybet england');
 const duplicates=rows.map(r=>({...r,engine:'ai_best'}));
 const corrupt=[historical(31,{kickoff_timestamp:now+1000,status:'won'}),historical(32,{recorded_at:now+10}),historical(33,{season_name:'Sportybet Italy - Week 1'})];
 assert.deepEqual(specialist.profiles([...rows,...duplicates,...corrupt],now,'sportybet england'),expected);
 assert.equal(expected[0].n,30);assert.equal(expected[0].candidate,true);
});
test('specialist prefers a positive earlier market trial at actual odds of at least two',()=>{
 const rows=Array.from({length:50},(_,i)=>historical(i));
 const pick=specialist.choose([fixture()],rows);
 assert.equal(pick.market,'Over 2.5 Goals');assert.equal(pick.price,2.1);assert.equal(pick.phase,'positive_market_trial');
 const missing=specialist.choose([fixture({bookmaker_odds:'{}'})],rows);assert.equal(missing,null);
 const exploration=specialist.choose([fixture()],[]);assert.equal(exploration.phase,'exploration');assert.ok(exploration.price>=2);
});
test('retired broad specialist cannot issue any new paper choices',()=>{
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE live_predictions(id INTEGER,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,match_time TEXT,predicted_probs TEXT,bookmaker_odds TEXT,scored_status INTEGER,actual_score TEXT);
 CREATE TABLE ml_pick_observations(id INTEGER PRIMARY KEY,engine TEXT,model_version TEXT,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,market TEXT,probability REAL,implied_odd REAL,fair_prob REAL,kickoff_timestamp INTEGER,match_time TEXT,recorded_at INTEGER,publish_eligible INTEGER,status TEXT DEFAULT 'pending',UNIQUE(engine,season_name,round_number));`);
 const m=fixture();db.prepare('INSERT INTO live_predictions VALUES(@id,@season_name,@round_number,@home_team,@away_team,@kickoff_timestamp,@match_time,@predicted_probs,@bookmaker_odds,0,NULL)').run(m);
 assert.equal(specialist.record(db,m.season_name),0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ml_pick_observations').get().n,0);
 db.close();
});
test('stats reset archives all observations and retries cannot silently create another period',()=>{
 const db=new Database(':memory:');db.exec("CREATE TABLE ai_best_picks_history(id INTEGER);INSERT INTO ai_best_picks_history VALUES(10);CREATE TABLE ml_pick_observations(id INTEGER);INSERT INTO ml_pick_observations VALUES(1)");
 const old=startRun(db,{startedAt:1000}),fresh=resetRun(db,old.id,2000),retry=resetRun(db,old.id,3000);
 assert.equal(fresh.started_at,2000);assert.equal(retry.id,fresh.id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tracking_runs').get().n,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ml_pick_observations').get().n,1);
 assert.equal(fresh.published_after_id,10);db.close();
});
