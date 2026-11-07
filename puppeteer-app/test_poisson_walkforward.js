const {test}=require('node:test');
const assert=require('node:assert/strict');
const {predictFromRows}=require('./utils/ml_predictor');
test('walk-forward prediction uses away-team home scoring history when away history is absent',()=>{
    const rows=[];
    for(let i=0;i<10;i++){
        rows.push({home_team:'Strong',away_team:'Opponent',home_score:4,away_score:0});
        rows.push({home_team:'Average',away_team:'Other',home_score:1,away_score:1});
    }
    const result=predictFromRows(rows,'Average','Strong',.015,1);
    assert.ok(result);
    assert.ok(result.awayWinProb>result.homeWinProb,'A strong team with only home history must not be treated as a zero-scoring away team');
    assert.ok(result.awayWinProb>.5);
});
