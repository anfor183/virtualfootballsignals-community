const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const engine=require('./utils/goals_engine'),learner=require('./utils/goals35_engine'),features=require('./utils/ai_best_market_features');
const now=Date.now(),season='Sportybet England - Week 9';
const fixture=(extra={})=>({id:1,season_name:season,round_number:9,home_team:'Home',away_team:'Away',kickoff_timestamp:now+600000,match_time:'15:00',
 bookmaker_odds:JSON.stringify({over25:1.9,under25:1.9,over35:3.2,under35:1.3}),...extra});
function database(){const db=new Database(':memory:');db.exec(`CREATE TABLE live_predictions(id INTEGER,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,match_time TEXT,bookmaker_odds TEXT,scored_status INTEGER,actual_score TEXT,actual_ht_score TEXT);
 CREATE TABLE historical_market_predictions(season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,actual_score TEXT,actual_ht_score TEXT);
 CREATE TABLE ml_pick_observations(id INTEGER PRIMARY KEY,engine TEXT,model_version TEXT,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,market TEXT,probability REAL,implied_odd REAL,fair_prob REAL,kickoff_timestamp INTEGER,match_time TEXT,recorded_at INTEGER,publish_eligible INTEGER,status TEXT DEFAULT 'pending',actual_score TEXT,actual_ht_score TEXT,UNIQUE(engine,season_name,round_number));`);return db;}
const insert=(db,m)=>db.prepare('INSERT INTO live_predictions VALUES(@id,@season_name,@round_number,@home_team,@away_team,@kickoff_timestamp,@match_time,@bookmaker_odds,0,NULL,NULL)').run(m);
const history=(score,n=80)=>[2.5,3.5].flatMap(goal_line=>Array.from({length:n},(_,i)=>({...fixture(),goal_line,fair_over:goal_line===2.5?.5:.3,
 home_team:'H'+i,away_team:'A'+i,kickoff_timestamp:now-1000000+i*1000,recorded_at:now-1000100+i*1000,settled_at:now-999900+i*1000,status:'settled',actual_score:score})));

test('one combined choice considers all four markets with actual prices and no odds floor of two',()=>{
 const result=engine.choose([fixture()],[],now);assert.equal(result.candidates.length,2);assert.equal(result.pick.engine,'goals');
 assert.ok(['Over 2.5 Goals','Under 2.5 Goals','Over 3.5 Goals','Under 3.5 Goals'].includes(result.pick.market));
 assert.equal(result.pick.price,JSON.parse(result.pick.match.bookmaker_odds)[(result.pick.market.startsWith('Over')?'over':'under')+String(result.pick.line).replace('.','')]);
 for(const bookmaker_odds of ['{}','broken',JSON.stringify({over25:2,under25:1})])assert.equal(engine.choose([fixture({bookmaker_odds})],[],now).pick,null);
 assert.equal(engine.choose([fixture({kickoff_timestamp:now})],[],now).pick,null);
});
test('each of the four markets can win the price-aware comparison from earlier patterns',()=>{
 const cases=[['4:0',{over25:1.8,under25:2,over35:3.2,under35:1.3},'Over 3.5 Goals'],
 ['0:0',{over25:1.5,under25:2.5,over35:3.2,under35:1.3},'Under 2.5 Goals'],
 ['3:0',{over25:2.2,under25:1.6,over35:3.2,under35:1.3},'Over 2.5 Goals'],
 ['3:0',{over25:1.1,under25:8,over35:2.1,under35:1.8},'Under 3.5 Goals']];
 for(const [score,odds,expected] of cases)assert.equal(engine.choose([fixture({bookmaker_odds:JSON.stringify(odds)})],history(score),now).pick.market,expected);
});
test('two goal thresholds stay coherent and each learns the correct outcome boundary',()=>{
 for(const score of ['2:0','3:0','4:0']){
  const rows=history(score,1);const y25=learner.trainingRows(rows,now,'sportybet england',2.5)[0].y,y35=learner.trainingRows(rows,now,'sportybet england',3.5)[0].y;
  assert.equal(y25,Number(Number(score[0])>=3));assert.equal(y35,Number(Number(score[0])>=4));
  const result=engine.choose([fixture()],rows,now);assert.ok(result.candidates[1].over<=result.candidates[0].over);
  for(const c of result.candidates)assert.ok(c.over>0&&c.over<1);
 }
 const crossed=engine.choose([fixture({bookmaker_odds:JSON.stringify({over25:4,under25:1.2,over35:1.2,under35:4})})],[],now).candidates;
 assert.equal(crossed[0].over,crossed[1].over);
});
test('training cannot mix goal lines, leak future scores or double-count another engine',()=>{
 const rows=history('4:0',5),expected=engine.choose([fixture()],rows,now);
 const duplicates=rows.map(r=>({...r,engine:'other',recorded_at:r.recorded_at+1}));
 const forbidden=[...rows.map(r=>({...r,kickoff_timestamp:now+1})),...rows.map(r=>({...r,settled_at:now+1})),...rows.map(r=>({...r,season_name:'Sportybet Italy - Week 9'}))];
 assert.deepEqual(engine.choose([fixture()], [...rows,...duplicates,...forbidden],now),expected);
 assert.equal(expected.models[2.5].rows,5);assert.equal(expected.models[3.5].rows,5);
});
test('one immutable paper observation per round captures both goal lines without issuing opposing picks',()=>{
 const db=database();insert(db,fixture());insert(db,fixture({id:2,home_team:'Other'}));
 assert.equal(engine.record(db,season),1);assert.equal(db.prepare('SELECT COUNT(*) n FROM goals_market_candidates').get().n,4);
 const first=db.prepare('SELECT * FROM ml_pick_observations').all();assert.equal(first.length,1);
 assert.equal(first[0].engine,'goals');assert.equal(first[0].publish_eligible,0);assert.ok(first[0].recorded_at<first[0].kickoff_timestamp);
 db.exec("UPDATE live_predictions SET bookmaker_odds='{\"over25\":9,\"under25\":1.1,\"over35\":9,\"under35\":1.1}'");
 assert.equal(engine.record(db,season),0);assert.deepEqual(db.prepare('SELECT * FROM ml_pick_observations').all(),first);
 assert.equal(learner.record(db,season),0);db.close();
});
test('both thresholds settle from exact results and the chosen market settles through the live observer',()=>{
 const db=database();insert(db,fixture());insert(db,fixture({id:2,home_team:'Missing'}));engine.record(db,season);
 db.prepare('INSERT INTO historical_market_predictions VALUES(?,?,?,?,?,?,NULL)').run(season,9,'Home','Away',now+600000,'3:0');
 db.prepare('INSERT INTO historical_market_predictions VALUES(?,?,?,?,?,?,NULL)').run(season,9,'Missing','Away',now+600001,'4:0');
 assert.equal(engine.settle(db),2);assert.equal(engine.settle(db),0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM goals_market_candidates WHERE status='pending'").get().n,2);
 const predictor=require('./utils/adaptive_market_predictor'),release=require('./utils/strategy_release');
 const load=predictor.loadBundle,queue=release.queueRefresh;predictor.loadBundle=()=>null;release.queueRefresh=()=>{};
 try{require('./utils/adaptive_market_observer').settle(db);}finally{predictor.loadBundle=load;release.queueRefresh=queue;}
 const pick=db.prepare('SELECT * FROM ml_pick_observations').get();
 assert.equal(pick.status,features.outcome(pick.market,'3:0',null)?'won':'lost');
 assert.equal(features.outcome('Over 2.5 Goals','3:0',null),true);assert.equal(features.outcome('Under 2.5 Goals','3:0',null),false);
 assert.equal(features.outcome('Over 3.5 Goals','3:0',null),false);assert.equal(features.outcome('Under 3.5 Goals','3:0',null),true);db.close();
});
test('changing the selected market keeps one Martingale cycle and one analytics record',async()=>{
 const {simulateBankroll}=await import('./utils/bankroll_simulator.mjs'),{scopeAnalytics}=await import('./utils/analytics_scope.mjs');
 const rows=['Over 3.5 Goals','Under 2.5 Goals','Over 2.5 Goals','Under 3.5 Goals'].map((market,i)=>({id:i,pick_type:'goals',market,status:i===2?'won':'lost',implied_odd:2,kickoff_timestamp:i+1}));
 const sim=simulateBankroll(rows,{mode:'martingale_2_0',baseStake:60,bankroll:100000});
 assert.deepEqual(sim.ledger.map(r=>r.stake),[60,120,240,60]);assert.equal(sim.stats.goals.played,4);
 const old=['over35','under35','market_specialist'].map((pick_type,i)=>({...rows[0],id:i+10,pick_type}));
 const report={paperTracking:{newSystem:{settledPicks:[...rows,...old]},settledPicks:[...rows,...old]}};
 assert.equal(scopeAnalytics(report).settledPicks.length,4);assert.equal(scopeAnalytics(report).stakeUnitsSummary.goals.played,4);
 assert.equal(scopeAnalytics(report,'paper').settledPicks.length,7);
});
