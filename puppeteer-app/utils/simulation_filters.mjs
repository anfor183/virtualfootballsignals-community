import {capturedOdds, engineType, ENGINE_TYPES, simulateBankroll} from './bankroll_simulator.mjs';

export function filterSimulationPicks(picks, filters={}, now=Date.now()) {
    const {strategy='all',market='all',minOdds='',maxOdds='',minProb=0,timeRange='all',outcome='all',team='',roundMin='',roundMax=''}=filters;
    const startOfToday=new Date(now).setHours(0,0,0,0);
    const startOfYesterday=startOfToday-86400000;
    const endOfYesterday=startOfToday-1;
    const since={
        today: startOfToday,
        last24h: now - 86400000,
        last3d: now - 3 * 86400000,
        last7d: now - 7 * 86400000,
        last30d: now - 30 * 86400000
    }[timeRange];
    let rows=picks.filter(p=> {
        if(strategy!=='all' && engineType(p)!==strategy) return false;
        if(market!=='all') {
            if(market==='goals_all') {if(!/over|under|both teams|gg/i.test(p.market||'')) return false;}
            else if(p.market!==market) return false;
        }
        const odd=capturedOdds(p);
        if(minOdds!=='' && odd<Number(minOdds) || maxOdds!=='' && odd>Number(maxOdds)) return false;
        if(Number(p.probability||0)<minProb) return false;
        if(outcome!=='all' && p.status!==outcome) return false;
        const term=team.trim().toLowerCase();
        if(term && !String(p.home_team||'').toLowerCase().includes(term) && !String(p.away_team||'').toLowerCase().includes(term)) return false;
        if(roundMin!=='' && Number(p.round_number)<Number(roundMin) || roundMax!=='' && Number(p.round_number)>Number(roundMax)) return false;

        const rawTs = p.kickoff_timestamp ?? p.recorded_at ?? p.timestamp ?? (p.created_at ? new Date(p.created_at).getTime() : 0);
        const kickoff = Number(rawTs) > 0 && Number(rawTs) < 1e11 ? Number(rawTs) * 1000 : Number(rawTs) || 0;

        if (timeRange === 'yesterday') {
            return kickoff >= startOfYesterday && kickoff <= endOfYesterday;
        }
        return since===undefined || kickoff>=since;
    }).sort((a,b)=>Number(a.kickoff_timestamp)-Number(b.kickoff_timestamp) || (a.id||0)-(b.id||0));
    const last={last100:100,last250:250,last500:500}[timeRange];
    if(last) rows=rows.slice(-last);
    return rows;
}

export function runSimulationView(picks, filters={}, options={}) {
    const filteredPicks=filterSimulationPicks(picks,filters);
    const replay=simulateBankroll(filteredPicks,options);
    // Last-N is applied separately to each standalone engine, exactly as when
    // selecting that engine in the dashboard; do not slice an all-engine mix.
    const standalone=Object.fromEntries(ENGINE_TYPES.map(type=>[type,simulateBankroll(
        filters.strategy && filters.strategy!=='all' && filters.strategy!==type ? []
            : filterSimulationPicks(picks,{...filters,strategy:type}),options)]));
    // Full counterfactual sequence even if the selected funded account stops.
    // Only fixed-base stake paths are independent of starting capital.
    const capitalReplay=options.mode==='fixed'||!options.mode||options.mode.startsWith('martingale')
        ? (options.funding==='unlimited'?replay:simulateBankroll(filteredPicks,{...options,funding:'unlimited'})) : null;
    return {filteredPicks,replay,standalone,capitalReplay};
}
