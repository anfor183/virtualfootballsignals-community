import {martingaleStake, oddsAdjustedMartingaleStake, normalizeStepCap} from './staking_cycle.mjs';

// The retired specialist key remains readable for archived simulations only.
export const ENGINE_TYPES = ['safest', 'high_value', 'ai_best_pick', 'goals', 'over35', 'under35', 'market_specialist'];
export const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;
export function engineType(pick) {
    const type = pick.pick_type || pick.engine || 'ai_best_pick';
    return ({high_chance:'high_value', ai_best:'ai_best_pick'})[type] || type;
}
export function capturedOdds(pick) {
    const actual = Number(pick.sportybet_odd), implied = Number(pick.implied_odd);
    return Number.isFinite(actual) && actual > 1 ? actual : implied;
}
const emptyStats = () => ({played:0, won:0, lost:0, void:0, profit:0, totalStaked:0, winRate:0, roi:0});

// Round-close replay: all simultaneous stakes are reserved from opening cash.
// No result from a round can set or finance another stake in that same round.
// Actual overlapping execution/settlement timestamps are not available here.
export function simulateBankroll(picks, {mode='fixed', bankroll=100000, baseStake=60, funding='funded', cap=7} = {}) {
    if (!['funded','unlimited'].includes(funding)) throw new Error('Unknown capital mode');
    const multipliers = {martingale_1_5:1.5, martingale_2_0:2, martingale_3_0:3};
    if (!['fixed','percent','compounding','kelly_half','kelly_quarter',...Object.keys(multipliers)].includes(mode)) throw new Error('Unknown staking mode');
    cap=normalizeStepCap(cap);
    bankroll=Number(bankroll); baseStake=Number(baseStake);
    if (!Number.isFinite(bankroll) || bankroll < 0 || !Number.isFinite(baseStake) || baseStake <= 0) throw new Error('Invalid bankroll or stake');
    bankroll=roundMoney(bankroll);
    let minimumCapital=0;
    let balance=bankroll, peak=bankroll, maxDrawdown=0, maxDrawdownPct=0, undefinedDrawdownPct=false, grossProfits=0, grossLosses=0;
    let invalidRows=0, pendingRows=0, skippedRows=0, stoppedAt=null, calculationLimit=null, cyclesReset=0, maxStake=0, extraCapitalRequired=0;
    const states = Object.fromEntries(ENGINE_TYPES.map(type => [type,{losses:0,wins:0,maxLosses:0,maxWins:0,accumulatedLoss:0}]));
    const stats = Object.fromEntries(['overall',...ENGINE_TYPES].map(type => [type,emptyStats()]));
    const ledger=[], equityPoints=[{idx:0,balance:bankroll}], groups=new Map();
    for (const pick of picks) {
        if (!['won','lost','void'].includes(pick.status)) {pendingRows++; continue;}
        const kickoff=Number(pick.kickoff_timestamp), odd=capturedOdds(pick), type=engineType(pick);
        if (!states[type] || !Number.isFinite(kickoff) || kickoff <= 0 || (pick.status !== 'void' && !(Number.isFinite(odd) && odd > 1))) {invalidRows++;continue;}
        if (!groups.has(kickoff)) groups.set(kickoff,[]);
        groups.get(kickoff).push({...pick,pick_type:type,odd,kickoff});
    }
    for (const [kickoff, group] of [...groups].sort((a,b)=>a[0]-b[0])) {
        // Canonical accounting order only. Funding and stake sizes do not use it.
        group.sort((a,b)=>a.pick_type.localeCompare(b.pick_type) || String(a.home_team||'').localeCompare(String(b.home_team||''))
            || String(a.away_team||'').localeCompare(String(b.away_team||'')) || String(a.market||'').localeCompare(String(b.market||'')) || (a.id||0)-(b.id||0));
        const bets=[];
        for (const pick of group) {
            if (pick.status==='void') {bets.push({...pick,stake:0});continue;}
            let stake=baseStake;
            if (mode==='percent') stake=bankroll*baseStake/100;
            else if (mode==='compounding') stake=Math.max(1,balance*baseStake/100);
            else if (multipliers[mode]) {
                const state = states[pick.pick_type];
                if (mode === 'martingale_2_0' && state.losses > 0 && pick.odd < 2.0) {
                    stake = oddsAdjustedMartingaleStake(baseStake, state.accumulatedLoss, pick.odd, baseStake, cap, state.losses);
                } else {
                    stake = martingaleStake(baseStake, multipliers[mode], state.losses, cap);
                }
            }
            else if (mode.startsWith('kelly')) {
                const probability=Number(pick.probability)/100, b=pick.odd-1;
                if (!Number.isFinite(probability) || probability<0 || probability>1) {invalidRows++;continue;}
                const fraction=(b*probability-(1-probability))/b*(mode==='kelly_half'?0.5:0.25);
                // Negative Kelly means no bet, rather than a forced minimum stake.
                if (fraction<=0) {skippedRows++;continue;}
                stake=balance*Math.min(0.20,fraction);
            }
            stake=pick.status==='void'?0:roundMoney(stake);
            // Never skip an overflowing Martingale stake and resume at a later win.
            if (!Number.isFinite(stake) || Math.abs(stake)*100>Number.MAX_SAFE_INTEGER) {
                calculationLimit={kickoff};break;
            }
            if (stake<0) {invalidRows++;continue;}
            if (!stake && pick.status!=='void') {skippedRows++;continue;}
            bets.push({...pick,stake});
        }
        if (calculationLimit) break;
        const required=roundMoney(bets.reduce((sum,p)=>sum+p.stake,0));
        const grossMovement=bets.reduce((sum,p)=>sum+Math.abs(p.status==='won'?p.stake*(p.odd-1):p.status==='lost'?p.stake:0),0);
        // Stop the whole round before money exceeds reliable cent arithmetic.
        if (![required, grossMovement, Math.abs(balance)+grossMovement, stats.overall.totalStaked+required,
            grossProfits+grossLosses+grossMovement].every(value=>Number.isFinite(value)&&value*100<=Number.MAX_SAFE_INTEGER)) {
            calculationLimit={kickoff};break;
        }
        minimumCapital=Math.max(minimumCapital,roundMoney(required-(balance-bankroll)));
        extraCapitalRequired=Math.max(extraCapitalRequired,roundMoney(required-balance));
        if (required>balance && funding==='funded') {stoppedAt={kickoff,required,available:balance};break;}
        const outcomes = new Map();
        for (const pick of bets) {
            const won=pick.status==='won', lost=pick.status==='lost';
            const profit=roundMoney(won?pick.stake*(pick.odd-1):lost?-pick.stake:0);
            balance=roundMoney(balance+profit);maxStake=Math.max(maxStake,pick.stake);
            if (profit>0) grossProfits=roundMoney(grossProfits+profit);
            if (profit<0) grossLosses=roundMoney(grossLosses-profit);
            for (const key of ['overall',pick.pick_type]) {
                const s=stats[key];
                if (pick.status==='void') s.void++;
                else {s.played++;s.won+=Number(won);s.lost+=Number(lost);s.totalStaked=roundMoney(s.totalStaked+pick.stake);s.profit=roundMoney(s.profit+profit);}
            }
            if (!outcomes.has(pick.pick_type)) outcomes.set(pick.pick_type,{wins:0,losses:0});
            outcomes.get(pick.pick_type).wins+=Number(won);outcomes.get(pick.pick_type).losses+=Number(lost);
            ledger.push({...pick,betIdx:ledger.length+1,profit,balanceAfter:balance,balance});
        }
        for (const [type, outcome] of outcomes) {
            const state=states[type];
            // If a legacy engine has multiple simultaneous picks, any win resets
            // its next round; only an all-losing batch increases its loss cycle.
            if (outcome.wins) {
                state.wins+=outcome.wins;
                state.losses=0;
                state.accumulatedLoss=0;
                state.maxWins=Math.max(state.maxWins,state.wins);
            }
            else if (outcome.losses) {
                const before=state.losses;
                state.losses+=outcome.losses;
                state.wins=0;
                const roundLoss = bets.filter(b => b.pick_type === type && b.status === 'lost').reduce((s, b) => s + b.stake, 0);
                state.accumulatedLoss = roundMoney(state.accumulatedLoss + roundLoss);
                state.maxLosses=Math.max(state.maxLosses,state.losses);
                if (cap !== null) {
                    const resets = Math.floor(state.losses/cap)-Math.floor(before/cap);
                    if (resets > 0) {
                        cyclesReset += resets;
                        state.accumulatedLoss = 0;
                    }
                }
            }
        }
        peak=Math.max(peak,balance);
        maxDrawdown=Math.max(maxDrawdown,roundMoney(peak-balance));
        if (peak<=0 && balance<peak) undefinedDrawdownPct=true;
        maxDrawdownPct=Math.max(maxDrawdownPct,peak>0?(peak-balance)/peak*100:0);
        if (bets.length) equityPoints.push({idx:ledger.length,kickoff,balance});
    }
    for (const [type,s] of Object.entries(stats)) {
        s.winRate=s.played?roundMoney(s.won/s.played*100):0;
        s.roi=s.totalStaked?roundMoney(s.profit/s.totalStaked*100):0;
        s.roc=bankroll?roundMoney(s.profit/bankroll*100):null;
        // Engine rows are contributions to ONE account, not fictitious accounts.
        s.balance=type==='overall'?balance:null;
    }
    return {mode,funding,cap,calculationLimit,
        minimumCapitalRequired:(mode==='fixed'||multipliers[mode])&&!stoppedAt&&!calculationLimit?minimumCapital:null,extraCapitalRequired,usedCredit:funding==='unlimited'&&extraCapitalRequired>0,
        startingBankroll:bankroll,baseStake,endingBankroll:balance,netProfit:roundMoney(balance-bankroll),
        peakBalance:peak,maxDrawdown,maxDrawdownPct:undefinedDrawdownPct?null:roundMoney(maxDrawdownPct),grossProfits,grossLosses,maxStake,
        maxWinStreak:Math.max(...Object.values(states).map(s=>s.maxWins)),maxLossStreak:Math.max(...Object.values(states).map(s=>s.maxLosses)),
        cyclesReset,unableToFundNextStake:!!stoppedAt,stoppedAt,invalidRows,pendingRows,skippedRows,
        unplayedRows:(stoppedAt||calculationLimit)?[...groups].filter(([kickoff])=>kickoff>=(stoppedAt||calculationLimit).kickoff).reduce((n,[,g])=>n+g.length,0):0,
        stats,ledger,equityPoints};
}

export function standaloneEngines(picks, options) {
    return Object.fromEntries(ENGINE_TYPES.map(type=>[type,simulateBankroll(picks.filter(p=>engineType(p)===type),options)]));
}

// Retain local peaks/troughs so a large loss and immediate recovery cannot vanish.
export function sampleEquity(points, limit=120) {
    if (points.length<=limit) return points;
    const result=new Map([[0,points[0]],[points.length-1,points.at(-1)]]);
    const bucket=Math.ceil((points.length-2)/Math.floor((limit-2)/2));
    for(let start=1;start<points.length-1;start+=bucket) {
        let min=start,max=start;
        for(let i=start;i<Math.min(start+bucket,points.length-1);i++) {
            if(points[i].balance<points[min].balance) min=i;
            if(points[i].balance>points[max].balance) max=i;
        }
        result.set(min,points[min]);result.set(max,points[max]);
    }
    return [...result].sort((a,b)=>a[0]-b[0]).map(([,p])=>p);
}
