const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const engine=require('./utils/goals35_engine');
const now=Date.now(),season='Sportybet England - Week 9';
const fixture=(extra={})=>({id:1,season_name:season,round_number:9,home_team:'Home',away_team:'Away',kickoff_timestamp:now+600000,
 match_time:'15:00',bookmaker_odds:JSON.stringify({over35:3.2,under35:1.3,over25:2,home:4}),...extra});
const history=(i,extra={})=>({...fixture(),id:i,home_team:'H'+i,away_team:'A'+i,kickoff_timestamp:now-1000000+i*1000,
 recorded_at:now-1000000+i*1000-100,settled_at:now-1000000+i*1000+100,status:'settled',fair_over:.3,actual_score:'2:2',...extra});
function database(){const db=new Database(':memory:');db.exec(`CREATE TABLE live_predictions(id INTEGER,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,match_time TEXT,bookmaker_odds TEXT,scored_status INTEGER,actual_score TEXT,actual_ht_score TEXT);
 CREATE TABLE historical_market_predictions(season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,actual_score TEXT,actual_ht_score TEXT);
 CREATE TABLE ml_pick_observations(id INTEGER PRIMARY KEY,engine TEXT,model_version TEXT,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,market TEXT,probability REAL,implied_odd REAL,fair_prob REAL,kickoff_timestamp INTEGER,match_time TEXT,recorded_at INTEGER,publish_eligible INTEGER,status TEXT DEFAULT 'pending',actual_score TEXT,actual_ht_score TEXT,UNIQUE(engine,season_name,round_number));`);return db;}
const insert=(db,m)=>db.prepare('INSERT INTO live_predictions VALUES(@id,@season_name,@round_number,@home_team,@away_team,@kickoff_timestamp,@match_time,@bookmaker_odds,0,NULL,NULL)').run(m);

test('only the two 3.5 markets use real paired prices, including odds below two',()=>{
 const result=engine.choose([fixture()],[],now);
 assert.deepEqual(Object.keys(result.picks),['over35','under35']);
 assert.equal(result.picks.under35.price,1.3);assert.equal(result.picks.over35.price,3.2);
 assert.equal(result.picks.over35.probability+result.picks.under35.probability,100);
 for(const odds of ['{}','invalid',JSON.stringify({over25:3,under25:1.2}),JSON.stringify({over35:3,under35:1}),JSON.stringify({over35:'bad',under35:1.3})])
  assert.deepEqual(engine.choose([fixture({bookmaker_odds:odds})],[],now).picks,{});
});
test('training has the correct three/four-goal boundary and excludes unavailable outcomes',()=>{
 const valid=[history(1,{actual_score:'2:1'}),history(2,{actual_score:'1:3'})];
 const invalid=[history(3,{recorded_at:now}),history(4,{kickoff_timestamp:now}),history(5,{settled_at:now+1}),history(6,{season_name:'Sportybet Italy - Week 9'}),history(7,{actual_score:'?'}),history(8,{status:'pending'})];
 const rows=engine.trainingRows([...valid,...invalid],now,'sportybet england');
 assert.deepEqual(rows.map(r=>r.y),[0,1]);
 const copies=valid.map(r=>({...r,fair_over:undefined,market:'Under 3.5 Goals',fair_prob:.7,engine:'safest',recorded_at:r.recorded_at+1}));
 assert.equal(engine.trainingRows([...valid,...copies],now,'sportybet england').length,2);
 assert.equal(engine.trainingRows([...valid,history(2,{actual_score:'0:0'})],now,'sportybet england').length,1);
});
test('earlier errors adapt the model; chronological calibration may reject a harmful adjustment',()=>{
 const allOver=Array.from({length:80},(_,i)=>history(i));
 assert.ok(engine.choose([fixture()],allOver,now).picks.over35.probability>engine.choose([fixture()],[],now).picks.over35.probability);
 const shift=Array.from({length:125},(_,i)=>history(i,{actual_score:i<100?'2:2':'0:0'}));
 const fit=engine.learn(shift,now,'sportybet england');assert.equal(fit.validationN,25);assert.equal(fit.blend,0);
 assert.equal(fit.validationLoss,fit.bookmakerLoss);
});
test('retired separate-side writer cannot capture or publish new choices',()=>{
 const db=database();insert(db,fixture());insert(db,fixture({id:2,home_team:'Other',bookmaker_odds:JSON.stringify({over35:2.5,under35:1.5})}));
 assert.equal(engine.record(db,season),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM ml_pick_observations').get().n,0);db.close();
});
test('candidate results use exact archived fixtures and leave missing outcomes pending',()=>{
 const db=database();db.exec('CREATE TABLE goals35_candidates(id INTEGER PRIMARY KEY,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,status TEXT,actual_score TEXT,settled_at INTEGER)');
 for(const home of ['Home','Missing'])db.prepare("INSERT INTO goals35_candidates(season_name,round_number,home_team,away_team,kickoff_timestamp,status) VALUES(?,?,?,?,?,'pending')").run(season,9,home,'Away',now+600000);
 db.prepare('INSERT INTO historical_market_predictions VALUES(?,?,?,?,?,?,NULL)').run(season,9,'Home','Away',now+600000,'1:3');
 // Results cannot be taken from a nearby kickoff or a different team pairing.
 db.prepare('INSERT INTO historical_market_predictions VALUES(?,?,?,?,?,?,NULL)').run(season,9,'Missing','Away',now+600001,'0:0');
 assert.equal(engine.settle(db),1);assert.equal(engine.settle(db),0);
 assert.deepEqual(db.prepare('SELECT home_team,status FROM goals35_candidates ORDER BY id').all(),[{home_team:'Home',status:'settled'},{home_team:'Missing',status:'pending'}]);
 db.close();
});
test('new analytics excludes retired trials while archive accounting remains readable',async()=>{
 const {scopeAnalytics}=await import('./utils/analytics_scope.mjs');
 const {simulateBankroll}=await import('./utils/bankroll_simulator.mjs');
 const rows=['over35','under35','market_specialist'].map((pick_type,i)=>({id:i,pick_type,status:i===0?'lost':'won',implied_odd:2,market:'Under 3.5 Goals',kickoff_timestamp:i+1}));
 const report={paperTracking:{newSystem:{settledPicks:rows},settledPicks:rows}};
 assert.equal(scopeAnalytics(report).settledPicks.length,0);assert.equal(scopeAnalytics(report,'paper').settledPicks.length,3);
 const result=simulateBankroll([rows[0],{...rows[0],id:4,kickoff_timestamp:2},{...rows[1],kickoff_timestamp:3}],{bankroll:100000,baseStake:60,mode:'martingale_2_0'});
 assert.deepEqual(result.ledger.map(r=>r.stake),[60,120,60]);
 assert.equal(result.stats.overall.totalStaked,240);
});
