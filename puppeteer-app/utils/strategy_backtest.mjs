import { MARTINGALE_CYCLE_CAP } from './staking_cycle.mjs';
import { simulateBankroll } from './bankroll_simulator.mjs';

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
export function simulateStrategy(picks, { mode = 'fixed', bankroll = 100000, baseStake = 60 } = {}) {
    if (!(bankroll > 0 && baseStake > 0)) throw new Error('Bankroll and stake must be positive');
    if (!['fixed','martingale_1_5','martingale_2_0','martingale_3_0'].includes(mode)) throw new Error('Unknown staking mode');
    const replay=simulateBankroll(picks,{mode,bankroll,baseStake,cap:MARTINGALE_CYCLE_CAP});
    const ledger=replay.ledger.filter(p=>p.status!=='void');
    const {endingBankroll:balance,maxDrawdown,maxStake,cyclesReset:resets,unableToFundNextStake:unfunded,
        invalidRows:invalid,pendingRows:pending,maxLossStreak:maxLossRun}=replay;
    const {totalStaked:stakeSum,won:wins}=replay.stats.overall;
    const grouped=new Map();
    for(const bet of ledger){const day=Math.floor((bet.kickoff+3600000)/86400000);grouped.set(day,(grouped.get(day)||0)+bet.profit);}
    let profitLower=null;
    const groups=[...grouped.values()];
    if(groups.length>=2){let seed=42;const draws=[];
        for(let i=0;i<2000;i++){let sum=0;for(let j=0;j<groups.length;j++){
            seed=(Math.imul(seed,1664525)+1013904223)>>>0;sum+=groups[Math.floor(seed/4294967296*groups.length)];}draws.push(sum);}
        draws.sort((a,b)=>a-b);profitLower=round(draws[100]);}
    return { mode, n:ledger.length, wins, winRate:ledger.length?round(wins/ledger.length*100):null,
        startingBankroll:bankroll,baseStake,endingBankroll:balance,netProfit:round(balance-bankroll),
        totalStaked:round(stakeSum),roi:stakeSum?round((balance-bankroll)/stakeSum*100):null,
        returnOnCapital:round((balance-bankroll)/bankroll*100),maxDrawdown:round(maxDrawdown),
        maxStake,maxLosingStreak:maxLossRun,cap:MARTINGALE_CYCLE_CAP,cyclesReset:resets,
        unableToFundNextStake:unfunded,invalidRows:invalid,pendingRows:pending,days:groups.length,
        dayClusterProfitLower:profitLower,
        evidencePassed:ledger.length>=100&&groups.length>=5&&!unfunded&&balance>bankroll&&profitLower>0 };
}

export function compareStrategies(picks, options = {}) {
    return Object.fromEntries(['fixed','martingale_1_5','martingale_2_0','martingale_3_0']
        .map(mode=>[mode,simulateStrategy(picks,{...options,mode})]));
}
