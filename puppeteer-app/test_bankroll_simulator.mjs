import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulateBankroll,standaloneEngines,sampleEquity,roundMoney} from './utils/bankroll_simulator.mjs';
import {simulateStrategy} from './utils/strategy_backtest.mjs';
import {filterSimulationPicks,runSimulationView} from './utils/simulation_filters.mjs';
const time=Date.UTC(2030,0,1,12);
const pick=(round,type,status='lost',odd=3.5,id=round)=>({id,pick_type:type,status,implied_odd:odd,kickoff_timestamp:time+round*180000,probability:50});
test('a Safest win cannot reset AI Best Martingale or affect its next stake',()=>{
    const rows=[...Array.from({length:3},(_,i)=>pick(i,'safest','won',1.03)),pick(0,'ai_best_pick'),pick(1,'ai_best_pick'),pick(2,'ai_best_pick','won',4)];
    const result=simulateBankroll(rows,{mode:'martingale_2_0',bankroll:10000});
    assert.deepEqual(result.ledger.filter(p=>p.pick_type==='ai_best_pick').map(p=>p.stake),[60,120,240]);
    assert.equal(result.stats.ai_best_pick.profit,540);
    assert.equal(result.stats.safest.profit,5.4);
    assert.equal(result.netProfit,545.4);
    assert.equal(result.endingBankroll,10545.4);
    assert.equal(result.stats.safest.balance,null);
});
test('simultaneous bets must all be funded before a winning result is known',()=>{
    const rows=[pick(0,'ai_best_pick','won',4,1),pick(0,'safest','lost',2,2)];
    for(const input of [rows,[...rows].reverse(),rows.map(p=>({...p,id:-p.id}))]) {
        const r=simulateBankroll(input,{bankroll:100});
        assert.equal(r.ledger.length,0);assert.equal(r.endingBankroll,100);
        assert.deepEqual(r.stoppedAt,{kickoff:time,required:120,available:100});
        assert.equal(r.unplayedRows,2);
    }
});
test('standalone AI comparison matches selecting only AI, including its funding stop',()=>{
    const rows=Array.from({length:15},(_,i)=>[pick(i,'safest','won',2),pick(i,'ai_best_pick')]).flat();
    const options={bankroll:1000,baseStake:60,mode:'martingale_2_0'};
    const independent=standaloneEngines(rows,options).ai_best_pick;
    const selected=simulateBankroll(filterSimulationPicks(rows,{strategy:'ai_best_pick'}),options);
    assert.deepEqual(independent,selected);
    assert.equal(independent.stats.overall.played,4);
    assert.equal(independent.endingBankroll,100);
    assert.equal(independent.unableToFundNextStake,true);
});
test('same-kickoff outcome ordering cannot change stakes, funding, net equity or drawdown',()=>{
    const rows=Array.from({length:20},(_,i)=>[pick(i,'safest',i%7?'won':'lost',1.25),pick(i,'ai_best_pick',i%3?'lost':'won',3.5)]).flat();
    const a=simulateBankroll(rows,{mode:'martingale_3_0'}),b=simulateBankroll([...rows].reverse().map(p=>({...p,id:999-p.id})),{mode:'martingale_3_0'});
    for(const field of ['endingBankroll','maxDrawdown','maxDrawdownPct','maxStake','netProfit']) assert.equal(a[field],b[field]);
    assert.deepEqual(a.equityPoints,b.equityPoints);
});
test('ledger, contributions, bankroll, stake totals and round-close chart reconcile to cents',()=>{
    const rows=Array.from({length:300},(_,i)=>['safest','high_value','ai_best_pick'].map((type,j)=>({...pick(i,type,(i*17+j*3)%11<6?'won':'lost',1.03+j*1.7),probability:25}))).flat();
    for(const mode of ['fixed','martingale_1_5','martingale_2_0','martingale_3_0','percent','compounding','kelly_half','kelly_quarter']) {
        const r=simulateBankroll(rows,{mode,baseStake:mode==='percent'||mode==='compounding'?0.1:60});
        const pnl=roundMoney(r.ledger.reduce((n,p)=>n+p.profit,0));
        assert.equal(r.netProfit,pnl);assert.equal(roundMoney(r.startingBankroll+pnl),r.endingBankroll);
        assert.equal(r.equityPoints.at(-1).balance,r.endingBankroll);
        assert.equal(roundMoney(['safest','high_value','ai_best_pick'].reduce((n,k)=>n+r.stats[k].profit,0)),r.netProfit);
        assert.equal(roundMoney(r.ledger.reduce((n,p)=>n+p.stake,0)),r.stats.overall.totalStaked);
        assert.ok(r.endingBankroll>=0);
    }
});
test('voids and pending or corrupt records cannot become losing bets or fabricated returns',()=>{
    const rows=[pick(0,'ai_best_pick'),pick(1,'ai_best_pick','void',null),pick(1,'ai_best_pick','pending'),pick(2,'ai_best_pick','won',2),pick(3,'ai_best_pick','won',null)];
    const r=simulateBankroll(rows,{mode:'martingale_2_0'});
    assert.equal(r.stats.overall.played,2);assert.equal(r.stats.overall.void,1);
    assert.equal(r.pendingRows,1);assert.equal(r.invalidRows,1);
    assert.equal(r.netProfit,60);
    assert.deepEqual(r.ledger.map(p=>p.stake),[60,0,120]);
});
test('negative Kelly edge abstains instead of inventing a minimum positive stake',()=>{
    const r=simulateBankroll([{...pick(0,'ai_best_pick','won',2),probability:40}],{mode:'kelly_half'});
    assert.equal(r.skippedRows,1);assert.equal(r.stats.overall.played,0);assert.equal(r.netProfit,0);
});
test('research evidence uses the same funded ledger as the dashboard for a single engine',()=>{
    const rows=Array.from({length:40},(_,i)=>pick(i,'ai_best_pick',i%4?'lost':'won',3.77));
    const options={mode:'martingale_2_0',bankroll:1000,baseStake:60};
    const a=simulateBankroll(rows,options),b=simulateStrategy(rows,options);
    assert.equal(b.n,a.stats.overall.played);assert.equal(b.netProfit,a.netProfit);
    assert.equal(b.endingBankroll,a.endingBankroll);assert.equal(b.totalStaked,a.stats.overall.totalStaked);
    assert.equal(b.maxDrawdown,a.maxDrawdown);assert.equal(b.unableToFundNextStake,a.unableToFundNextStake);
});
test('chart sampling retains a one-round extreme loss and the final recovery',()=>{
    const points=Array.from({length:1000},(_,idx)=>({idx,balance:idx===123?5:idx===456?150000:100000}));
    const sampled=sampleEquity(points);
    assert.ok(sampled.length<=120);assert.equal(Math.min(...sampled.map(p=>p.balance)),5);
    assert.equal(Math.max(...sampled.map(p=>p.balance)),150000);assert.equal(sampled.at(-1),points.at(-1));
});
test('today filtering uses Lagos midnight independent of the machine timezone',()=>{
    const now=Date.UTC(2030,0,2,0,30);
    const rows=[{...pick(0,'safest'),kickoff_timestamp:Date.UTC(2030,0,1,22,59)}, {...pick(1,'safest'),kickoff_timestamp:Date.UTC(2030,0,1,23,1)}];
    assert.equal(filterSimulationPicks(rows,{timeRange:'today'},now).length,1);
});
test('last-N standalone comparison matches the same selected-engine replay',()=>{
    const rows=Array.from({length:120},(_,i)=>[pick(i,'safest','won',1.03),pick(i,'ai_best_pick',i%3?'lost':'won')]).flat();
    const options={mode:'martingale_2_0'};
    const all=runSimulationView(rows,{timeRange:'last100',strategy:'all'},options);
    const ai=runSimulationView(rows,{timeRange:'last100',strategy:'ai_best_pick'},options);
    assert.equal(all.filteredPicks.length,100);
    assert.deepEqual(all.standalone.ai_best_pick,ai.replay);
    assert.equal(ai.replay.stats.overall.played,100);
});
test('unlimited capital continues every eligible bet, exposes debt and peak funding shortfall',()=>{
    const rows=Array.from({length:16},(_,i)=>pick(i,'ai_best_pick'));
    const funded=simulateBankroll(rows,{bankroll:1000,mode:'martingale_2_0'});
    const unlimited=simulateBankroll(rows,{bankroll:1000,mode:'martingale_2_0',funding:'unlimited'});
    assert.equal(funded.stats.overall.played,4);
    assert.equal(unlimited.stats.overall.played,16);
    assert.equal(unlimited.endingBankroll,1000-60*(127+127+1+2));
    assert.equal(unlimited.unableToFundNextStake,false);assert.equal(unlimited.usedCredit,true);
    assert.equal(unlimited.extraCapitalRequired,-unlimited.endingBankroll);
    assert.equal(unlimited.netProfit,unlimited.stats.overall.profit);
    // Unlimited debt is never used by the independent release-proof wrapper.
    assert.equal(simulateStrategy(rows,{bankroll:1000,mode:'martingale_2_0',funding:'unlimited'}).n,4);
});


test('uncapped Martingale continues beyond seven losses for every multiplier',()=>{
    const rows=Array.from({length:10},(_,i)=>pick(i,'goals'));
    for(const [mode,multiplier] of [['martingale_1_5',1.5],['martingale_2_0',2],['martingale_3_0',3]]) {
        const r=simulateBankroll(rows,{mode,cap:null,funding:'unlimited'});
        assert.deepEqual(r.ledger.map(p=>p.stake),rows.map((_,i)=>roundMoney(60*multiplier**i)));
        assert.equal(r.cyclesReset,0);assert.equal(r.cap,null);assert.equal(r.stats.overall.played,10);
    }
});
test('custom caps include the base bet and reset exactly at the chosen length',()=>{
    const rows=Array.from({length:9},(_,i)=>pick(i,'goals'));
    for(const cap of [1,3,8]) {
        const r=simulateBankroll(rows,{mode:'martingale_2_0',cap,funding:'unlimited'});
        assert.deepEqual(r.ledger.map(p=>p.stake),rows.map((_,i)=>60*2**(i%cap)));
        assert.equal(r.cyclesReset,Math.floor(9/cap));
    }
});
test('a win resets uncapped progression and a void leaves it unchanged',()=>{
    const rows=[pick(0,'goals'),pick(1,'goals','void'),pick(2,'goals','won'),pick(3,'goals')];
    const r=simulateBankroll(rows,{mode:'martingale_3_0',cap:null});
    assert.deepEqual(r.ledger.map(p=>p.stake),[60,0,180,60]);
});
test('custom and uncapped options match standalone selection and shared/export replay',()=>{
    const rows=Array.from({length:10},(_,i)=>[pick(i,'goals'),pick(i,'safest','won')]).flat();
    for(const cap of [null,3,9]) {
        const options={mode:'martingale_2_0',funding:'unlimited',cap};
        const all=runSimulationView(rows,{},options);
        const goals=runSimulationView(rows,{strategy:'goals'},options);
        assert.deepEqual(all.standalone.goals,goals.replay);
        assert.deepEqual(all.replay.ledger.filter(p=>p.pick_type==='goals').map(p=>p.stake),goals.replay.ledger.map(p=>p.stake));
    }
});
test('funded uncapped replay still cannot spend an unaffordable stake',()=>{
    const r=simulateBankroll(Array.from({length:20},(_,i)=>pick(i,'goals')),{mode:'martingale_2_0',cap:null,bankroll:1000});
    assert.equal(r.ledger.length,4);assert.equal(r.endingBankroll,100);assert.equal(r.stoppedAt.required,960);
});
test('invalid step caps are rejected, never rounded into another strategy',()=>{
    for(const cap of [0,-1,1.5,Infinity,NaN,'oops']) assert.throws(()=>simulateBankroll([],{cap}),/Step cap/);
    assert.equal(simulateBankroll([],{cap:''}).cap,null);
});
test('uncapped precision overflow stops before the whole round without skipping losses',()=>{
    const rows=Array.from({length:1000},(_,i)=>pick(i,'goals',i===999?'won':'lost'));
    const r=simulateBankroll(rows,{mode:'martingale_3_0',cap:null,funding:'unlimited'});
    assert.ok(r.calculationLimit);assert.equal(r.invalidRows,0);assert.equal(r.skippedRows,0);
    assert.equal(r.ledger.length+r.unplayedRows,1000);assert.equal(r.ledger.at(-1).status,'lost');
    assert.ok(Number.isFinite(r.endingBankroll));assert.equal(r.stats.overall.won,0);
});
test('custom UI cap and credit cannot alter the seven-bet funded qualification wrapper',()=>{
    const rows=Array.from({length:9},(_,i)=>pick(i,'goals'));
    for(const cap of [null,3,9]) {
        const r=simulateStrategy(rows,{mode:'martingale_2_0',cap,funding:'unlimited'});
        assert.equal(r.cap,7);assert.equal(r.maxStake,3840);assert.equal(r.totalStaked,7800);
    }
});

test('fixed-base unlimited profit is capital-independent while balances, funding and ROC respond',()=>{
 const rows=[pick(0,'goals'),pick(1,'goals','won',3)];
 const results=[0,100,1000].map(bankroll=>simulateBankroll(rows,{bankroll,mode:'martingale_2_0',cap:null,funding:'unlimited'}));
 for(const r of results){assert.equal(r.netProfit,180);assert.equal(r.stats.overall.totalStaked,180);assert.equal(r.endingBankroll,r.startingBankroll+180);}
 assert.equal(results[0].stats.overall.roc,null);assert.equal(results[1].stats.overall.roc,180);assert.equal(results[2].stats.overall.roc,18);
 assert.equal(results[0].extraCapitalRequired,180);assert.equal(results[1].extraCapitalRequired,80);assert.equal(results[2].extraCapitalRequired,0);
 assert.equal(results[0].maxDrawdownPct,null);
 assert.equal(simulateBankroll(rows,{bankroll:0}).ledger.length,0);
});
test('debt drawdown uses its prior positive peak and may legitimately exceed 100 percent',()=>{
 const r=simulateBankroll([pick(0,'goals'),pick(1,'goals')],{bankroll:100,baseStake:60,funding:'unlimited'});
 assert.equal(r.endingBankroll,-20);assert.equal(r.maxDrawdown,120);assert.equal(r.maxDrawdownPct,120);
});

test('minimum capital reserves the next stake before using its eventual winning return',()=>{
 const rows=[pick(0,'goals'),pick(1,'goals','won',3)];
 const options={mode:'martingale_2_0',cap:null};
 for(const bankroll of [0,100,100000]) assert.equal(simulateBankroll(rows,{...options,bankroll,funding:'unlimited'}).minimumCapitalRequired,180);
 assert.equal(simulateBankroll(rows,{...options,bankroll:180}).stats.overall.played,2);
 assert.equal(simulateBankroll(rows,{...options,bankroll:179.99}).stats.overall.played,1);
 const view=runSimulationView(rows,{}, {...options,bankroll:0});
 assert.equal(view.replay.ledger.length,0);assert.equal(view.capitalReplay.minimumCapitalRequired,180);
});
test('minimum capital combines simultaneous engines and can be smaller than drawdown after profits',()=>{
 const together=[pick(0,'goals','won',2),pick(0,'safest','won',2)];
 assert.equal(simulateBankroll(together,{funding:'unlimited'}).minimumCapitalRequired,120);
 const rows=[pick(0,'goals','won',11),...Array.from({length:3},(_,i)=>pick(i+1,'goals'))];
 const r=simulateBankroll(rows,{baseStake:10,funding:'unlimited'});
 assert.equal(r.minimumCapitalRequired,10);assert.equal(r.maxDrawdown,30);
 assert.equal(runSimulationView(rows,{}, {mode:'percent'}).capitalReplay,null);
 assert.equal(simulateBankroll([]).minimumCapitalRequired,0);
});
