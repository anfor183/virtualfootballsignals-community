const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const Database=require('better-sqlite3');
const f=require('./utils/ai_best_market_features');
const {choose}=require('./utils/adaptive_market_predictor');
const schedule=require('./utils/training_schedule');
const observer=require('./utils/adaptive_market_observer');
function row(id,time,extra={}){return {id,season_name:'Sportybet England - Week 1 (test)',round_number:1,
    home_team:'A',away_team:'B',kickoff_timestamp:time,actual_score:'2:0',actual_ht_score:'1:0',
    predicted_probs:JSON.stringify({homeWinProb:65,drawProb:20,awayWinProb:15,over15Prob:80,over25Prob:40}),
    bookmaker_odds:JSON.stringify({home:1.4,draw:4,away:7,dc1x:1.01,x2:3.3,dc12:1.2,over15:1.3,under15:4,over25:2.5,under25:1.5}),...extra};}
test('features use chronology, league scope and strict earlier kickoffs, not insertion ids',()=>{
    const rows=[row(90,1000),row(3,2000),row(2,2000,{home_team:'C'}),row(1,3000)];
    const build=a=>f.buildDataset(structuredClone(a),1.000001).entries.find(e=>e.id===3&&e.market===0).features;
    const expected=build(rows);
    const future=structuredClone(rows);future[3].actual_score='0:6';assert.deepEqual(build(future),expected);
    const simultaneous=structuredClone(rows);simultaneous[2].actual_score='0:6';assert.deepEqual(build(simultaneous),expected);
    const otherLeague=structuredClone(rows);otherLeague[0].season_name='Sportybet Italy - Week 1';
    assert.notDeepEqual(build(otherLeague),expected);
});
test('missing prices cannot fabricate high-odds picks; low prices remain available to Safest',()=>{
    assert.equal(f.candidates(row(1,2000,{bookmaker_odds:'{}'}),[],3.3).length,0);
    assert.ok(f.candidates(row(1,2000),[],1.000001).some(c=>c.market==='1X'&&c.price===1.01));
    assert.ok(f.candidates(row(1,2000),[],3.3).every(c=>c.price>=3.3));
});
test('HT/FT needs real halftime results; double-chance settlement works independently',()=>{
    assert.equal(f.outcome('HT/FT 1/1','2:0',null),null);
    assert.equal(f.outcome('1X','2:0',null),true);
    assert.equal(f.outcome('X2','2:0',null),false);
});
test('AI Best ranks winning chance ahead of payout inside validated high-odds candidates',()=>{
    const candidates=[{market:'A',marketIndex:0,price:10},{market:'B',marketIndex:1,price:3.3}];
    const report={engine:'ai_best_adaptive',ready_for_deployment:true,thresholds:{0:{min_prob:.3,min_ev:.03},1:{min_prob:.3,min_ev:.03}}};
    assert.equal(choose(candidates,[.4,.6],report).market,'B');
    assert.equal(choose(candidates,[.4,.6],{...report,thresholds:{}}),null);
});
test('unvalidated and drift-paused models cannot publish; shadow observations remain possible',()=>{
    const c=[{market:'Home Win',marketIndex:0,price:4}];
    const r={engine:'ai_best_adaptive',ready_for_deployment:false};
    assert.equal(choose(c,[.6],r),null);
    assert.equal(choose(c,[.6],r,{shadow:true}).market,'Home Win');
    assert.equal(choose(c,[.6],{...r,ready_for_deployment:true},{paused:true}),null);
});
test('Safest has no odds reward or positive-EV constraint in its ranking objective',()=>{
    const c=[{market:'Low',price:1.01},{market:'High',price:5}];
    assert.equal(choose(c,[.97,.55],{engine:'safest_adaptive',ready_for_deployment:true}).market,'Low');
});
test('new-result watermark still advances with a constant retained row count',()=>{
    const db=new Database(':memory:');db.exec('CREATE TABLE live_predictions (id INTEGER,kickoff_timestamp INTEGER,scored_status INTEGER,actual_score TEXT)');
    const insert=db.prepare("INSERT INTO live_predictions VALUES (?,?,1,'1:0')");
    for(let i=1;i<=2000;i++)insert.run(i,i*1000);
    const before=schedule.progress(db,2000);assert.equal(before.newResults,0);
    db.exec('DELETE FROM live_predictions WHERE id<=150');for(let i=2001;i<=2150;i++)insert.run(i,i*1000);
    const after=schedule.progress(db,2000);assert.equal(after.count,before.count);assert.equal(after.newResults,150);
    assert.equal(schedule.due(after,{lastTrainedPredictionId:2000,lastTrainedAt:new Date(Date.now()-3600000).toISOString()}),true);
    db.close();
});
test('cross-process training lock preserves the live owner and requires the matching token',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ml-lock-test-')),file=path.join(dir,'lock');
    const token=schedule.acquire(file);assert.ok(token);assert.equal(schedule.acquire(file),null);
    schedule.release(file,'wrong');assert.ok(fs.existsSync(file));schedule.release(file,token);
    assert.equal(fs.existsSync(file),false);fs.rmdirSync(dir);
});
test('prospective drift monitoring is isolated by engine and model version',()=>{
    const db=new Database(':memory:');
    db.exec(`CREATE TABLE ml_pick_observations(engine TEXT,model_version TEXT,probability REAL,implied_odd REAL,
        fair_prob REAL,status TEXT,kickoff_timestamp INTEGER)`);
    const add=db.prepare('INSERT INTO ml_pick_observations VALUES (?,?,?,?,?,?,?)');
    for(let i=0;i<100;i++)add.run('ai_best','v1',95,4,.2,'lost',i);
    assert.equal(observer.monitoring(db,'ai_best','v1').paused,true);
    assert.equal(observer.monitoring(db,'safest','v1').n,0);
    assert.equal(observer.monitoring(db,'ai_best','v2').n,0);db.close();
});
