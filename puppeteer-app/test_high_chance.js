const {test}=require('node:test');
const assert=require('node:assert/strict');
const f=require('./utils/ai_best_market_features');
const {choose}=require('./utils/adaptive_market_predictor');
const {policySummary}=require('./utils/adaptive_market_observer');
const {pickDecision}=require('./utils/pick_policy');
function row(id,extra={}){return {id,season_name:'Sportybet England - Week 1',round_number:1,home_team:'A',away_team:'B',
    kickoff_timestamp:id*180000,actual_score:'2:1',actual_ht_score:'1:0',
    predicted_probs:{homeWinProb:60,drawProb:20,awayWinProb:20,over25Prob:80,ggProb:75},
    bookmaker_odds:{over25:1.9,under25:1.9,gg:1.9,ng:1.9,home:2,draw:4,away:4},...extra};}
test('High Chance preserves real-price range and canonical blocked market aliases',()=>{
    const policy=f.enginePolicy('high_chance',{blockedMarkets:{high_value:['BTTS']}});
    const c=f.candidates(row(2),[row(1)],1.65,policy);
    assert.deepEqual(c.map(x=>x.market),['Over 2.5 Goals']);
    assert.equal(f.candidates(row(2,{bookmaker_odds:{over25:1.64,under25:2.5}}),[],1.65,policy).length,0);
    assert.equal(f.candidates(row(2,{bookmaker_odds:{over25:3.51,under25:1.2}}),[],1.65,policy).length,0);
    assert.equal(f.candidates(row(2,{bookmaker_odds:{}}),[],1.65,policy).length,0);
});
test('High Chance error-context features use only earlier results in the same league',()=>{
    const p=f.enginePolicy('high_chance'), target=row(3);
    const build=history=>f.candidates(target,history,1.65,p)[0].features;
    assert.deepEqual(build([row(1)]),build([row(1),row(3,{actual_score:'0:0'}),row(4,{actual_score:'0:0'})]));
    assert.notDeepEqual(build([row(1)]),build([row(1,{actual_score:'0:0'})]));
    assert.deepEqual(build([]),build([row(1,{season_name:'Sportybet Italy - Week 1'})]));
    assert.equal(build([]).length,f.candidates(target,[],1.65)[0].features.length+7);
});
test('an unready High Chance model cannot fall back to raw forecasts; policy evaluation stays paper',()=>{
    const c=[{market:'Over 2.5 Goals',marketIndex:7,price:1.9}];
    const report={engine:'high_chance_adaptive',ready_for_deployment:false,thresholds:{7:{min_prob:.75,min_ev:.03}}};
    assert.equal(choose(c,[.8],report),null);
    assert.equal(choose(c,[.8],report,{validation:true}).market,'Over 2.5 Goals');
    assert.equal(choose(c,[.7],report,{validation:true}),null);
    assert.equal(require('./utils/high_chance_predictor').scoreRound([{rawProbs:{over25Prob:99},bookOdds:{over25:2}}]),null);
    assert.equal(pickDecision('high_chance',{match_time:'08:59'}).allowed,false);
});
test('qualified forward policy may choose a different fixture than the unfiltered shadow ranking',()=>{
    const c=[{market:'A',marketIndex:0,price:1.1},{market:'B',marketIndex:1,price:2}];
    const report={engine:'high_chance_adaptive',ready_for_deployment:false,thresholds:{0:{min_prob:.75,min_ev:.03},1:{min_prob:.75,min_ev:.03}}};
    assert.equal(choose(c,[.8,.75],report,{shadow:true}).market,'A');
    assert.equal(choose(c,[.8,.75],report,{validation:true}).market,'B');
});
test('prospective release needs sufficient qualified picks across days and actual positive returns',()=>{
    const rows=[];
    for(let day=0;day<5;day++)for(let j=0;j<20;j++)rows.push({kickoff_timestamp:Date.UTC(2030,0,day+1,12)+j*1000,
        implied_odd:1.9,status:j<16?'won':'lost'});
    assert.equal(policySummary(rows).forward_validation_passed,true);
    assert.equal(policySummary(rows.slice(0,99)).forward_validation_passed,false);
    assert.equal(policySummary(rows.map(r=>({...r,implied_odd:1.01}))).forward_validation_passed,false);
    assert.equal(policySummary(rows.map(r=>({...r,kickoff_timestamp:Date.UTC(2030,0,1,12)}))).forward_validation_passed,false);
});
