const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MatchContext,NAMES}=require('./utils/match_context_features');
const features=require('./utils/ai_best_market_features');
const start=Date.UTC(2030,0,1,12);
function round(number,score='3:0',offset=0,scope='Sportybet England'){
    return Array.from({length:10},(_,i)=>({id:offset+number*10+i,season_name:`${scope} - Week ${number}`,round_number:number,
        home_team:`T${i*2}`,away_team:`T${i*2+1}`,kickoff_timestamp:start+offset+(number-1)*180000,
        actual_score:score,actual_ht_score:'0:0',predicted_probs:{over25Prob:65,homeWinProb:60,drawProb:20,awayWinProb:20},
        bookmaker_odds:{over25:1.9,under25:1.9,home:1.7,draw:4,away:5}}));
}
function value(vector,name){return vector[NAMES.indexOf(name)];}
test('current tables and team form are reconstructed only after earlier complete rounds',()=>{
    const state=new MatchContext(),fixture=round(2)[0];
    state.ingestBatch(round(1));const vector=state.features(fixture);
    assert.equal(vector.length,NAMES.length);assert.equal(value(vector,'table_complete'),1);
    assert.equal(value(vector,'home_points_per_game'),1);assert.equal(value(vector,'away_points_per_game'),0);
    assert.equal(value(vector,'home_form_points'),1);assert.equal(value(vector,'away_form_points'),0);
    assert.equal(value(vector,'home_played'),1/38);
    assert.equal(value(state.features(round(1)[0]),'table_complete'),0);
});
test('five meetings respect venue orientation and ignore the sixth older meeting',()=>{
    const state=new MatchContext();for(let r=1;r<=6;r++)state.ingestBatch(round(r,r===1?'9:0':'1:2'));
    const home=state.features(round(7)[0]);assert.equal(value(home,'h2h_count'),1);
    assert.equal(value(home,'h2h_home_win'),0);assert.equal(value(home,'h2h_home_goals'),.2);
    const reversed=state.features({...round(7)[0],home_team:'T1',away_team:'T0'});
    assert.equal(value(reversed,'h2h_home_win'),1);assert.equal(value(reversed,'h2h_home_goals'),.4);
});
test('tables reset across seasons; incomplete archives and other leagues cannot invent standings',()=>{
    const state=new MatchContext();state.ingestBatch(round(1));state.ingestBatch(round(2));
    assert.equal(value(state.features(round(3, '0:0',0,'Sportybet Italy')[0]),'h2h_count'),0);
    const nextSeason=38*180000;state.ingestBatch(round(1,'0:0',nextSeason));
    const vector=state.features(round(2,'0:0',nextSeason)[0]);
    assert.equal(value(vector,'table_complete'),1);assert.equal(value(vector,'home_points_per_game'),1/3);
    assert.equal(value(vector,'home_form_count'),.2);assert.equal(value(vector,'h2h_count'),.6);
    const partial=new MatchContext();partial.ingestBatch(round(8));
    assert.equal(value(partial.features(round(9)[0]),'table_complete'),0);
});
test('training never uses simultaneous or future results as last-five/table context',()=>{
    const rows=[...round(1),...round(2),...round(3)];
    const policy=features.enginePolicy('high_chance',{},true);
    const build=source=>features.buildDataset(source,1.65,policy).entries.find(e=>e.id===20&&e.market===7).features;
    const original=build(rows),changed=structuredClone(rows);
    changed.find(r=>r.id===21).actual_score='0:9';changed.find(r=>r.id===30).actual_score='0:9';
    assert.deepEqual(build(changed),original);
    assert.equal(original.length,features.candidates(round(2)[0],round(1),1.65,features.enginePolicy('high_chance')).at(0).features.length+NAMES.length);
});
test('bounded fitting samples preserve the full contiguous audit staking sequence',()=>{
    const rows=Array.from({length:30},(_,i)=>round(i+1)).flat();
    const data=features.buildDataset(rows,1.65,features.enginePolicy('high_chance'),6);
    const expected=rows.filter(r=>r.kickoff_timestamp>=data.split_cutoffs[2]).map(r=>r.id);
    const actual=[...new Set(data.entries.filter(e=>e.kickoff>=data.split_cutoffs[2]).map(e=>e.id))];
    assert.deepEqual(actual,expected);
});
