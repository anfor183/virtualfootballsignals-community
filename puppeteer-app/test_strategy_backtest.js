const {test}=require('node:test');
const assert=require('node:assert/strict');
function pick(index,status='lost',odds=2){return {id:index,kickoff_timestamp:Date.UTC(2030,0,1,12)+index*180000,status,implied_odd:odds};}
test('2x uses seven bets per cycle and never stays at the maximum after the cap',async()=>{
    const {simulateStrategy}=await import('./utils/strategy_backtest.mjs');
    const result=simulateStrategy(Array.from({length:8},(_,i)=>pick(i)),{mode:'martingale_2_0'});
    assert.equal(result.totalStaked,60*(127+1));assert.equal(result.maxStake,3840);
    assert.equal(result.cyclesReset,1);assert.equal(result.netProfit,-7680);
});
test('a high hit rate and a doubled winning stake do not imply recovery at short odds',async()=>{
    const {simulateStrategy}=await import('./utils/strategy_backtest.mjs');
    const rows=[pick(0),pick(1,'won',1.03)];
    assert.equal(simulateStrategy(rows,{mode:'martingale_2_0'}).netProfit,-56.4);
    const mostlyWins=Array.from({length:100},(_,i)=>pick(i,i%10?'won':'lost',1.01));
    const result=simulateStrategy(mostlyWins);assert.equal(result.winRate,90);assert.ok(result.netProfit<0);
    assert.equal(result.evidencePassed,false);
});
test('simulation cannot invent credit, odds, or outcomes to make the curve profitable',async()=>{
    const {simulateStrategy}=await import('./utils/strategy_backtest.mjs');
    const result=simulateStrategy(Array.from({length:30},(_,i)=>pick(i)),{bankroll:1000,mode:'martingale_2_0'});
    assert.equal(result.unableToFundNextStake,true);assert.ok(result.endingBankroll>=0);assert.equal(result.n,4);
    const invalid=simulateStrategy([pick(0,'pending'),pick(1,'won',null)]);
    assert.equal(invalid.n,0);assert.equal(invalid.pendingRows,1);assert.equal(invalid.invalidRows,1);
    assert.equal(invalid.roi,null);
});
test('day bootstrap resamples both days instead of repeating the same profit total',async()=>{
    const {simulateStrategy}=await import('./utils/strategy_backtest.mjs');
    const rows=[pick(0,'won'),{...pick(1),kickoff_timestamp:Date.UTC(2030,0,2,12)}];
    const result=simulateStrategy(rows);
    assert.equal(result.netProfit,0);assert.equal(result.dayClusterProfitLower,-120);
});
