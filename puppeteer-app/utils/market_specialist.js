'use strict';
// Independent Bayesian market-selection strategy. Paper observations only until
// a separate, complete historical/forward qualification exists for this policy.
const features=require('./ai_best_market_features');
const VERSION='market-specialist-bayes-v1';
const band=price=>price<2.5?'2–2.49':price<3.3?'2.5–3.29':price<5?'3.3–4.99':price<10?'5–9.99':'10+';
function profiles(rows,before,leagueScope) {
    const grouped=new Map(),seen=new Set();
    const ordered=rows.filter(r=>r.recorded_at<r.kickoff_timestamp && r.kickoff_timestamp<before &&
        ['won','lost'].includes(r.status) && Number(r.implied_odd)>=2 && Number.isFinite(Number(r.implied_odd)) &&
        (!leagueScope || features.scope(r)===leagueScope)).sort((a,b)=>a.kickoff_timestamp-b.kickoff_timestamp || a.recorded_at-b.recorded_at || (a.id||0)-(b.id||0));
    for(const r of ordered) {
        // Three engines choosing the same fixture/market provide one outcome.
        const identity=[features.scope(r),r.kickoff_timestamp,r.home_team,r.away_team,r.market].join('|');
        if(seen.has(identity))continue;seen.add(identity);
        const key=r.market+'|'+band(Number(r.implied_odd));
        if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(r);
    }
    return [...grouped].map(([key,all])=> {
        const sample=all.slice(-250),n=sample.length,recent=sample.slice(-50);
        let weight=0,wins=0;
        sample.forEach((r,i)=>{const w=2**(-(n-1-i)/50);weight+=w;wins+=w*Number(r.status==='won');});
        const profit=sample.reduce((s,r)=>s+(r.status==='won'?r.implied_odd-1:-1),0);
        const recentProfit=recent.reduce((s,r)=>s+(r.status==='won'?r.implied_odd-1:-1),0);
        return {key,market:sample[0].market,oddsBand:band(sample[0].implied_odd),n,weight,wins,
            winRate:sample.filter(r=>r.status==='won').length/n*100,flatRoi:profit/n*100,recentFlatRoi:recentProfit/recent.length*100,
            candidate:n>=20 && profit>0 && recentProfit>0};
    });
}
function choose(matches,observations) {
    if(!matches.length)return null;
    const before=Math.min(Date.now(),...matches.map(r=>Number(r.kickoff_timestamp)));
    const known=profiles(observations,before,features.scope(matches[0])),byKey=new Map(known.map(p=>[p.key,p]));
    const candidates=[];
    for(const match of matches) for(const c of features.candidates(match,[],2,{markets:features.MARKETS,blockedMarkets:[],maxOdds:Number.MAX_SAFE_INTEGER})) {
        const profile=byKey.get(c.market+'|'+band(c.price));
        const probability=((profile?.wins||0)+20*c.fair)/((profile?.weight||0)+20);
        candidates.push({...c,profile,probability,estimatedEv:probability*c.price-1,
            candidate:!!profile?.candidate && probability*c.price>1});
    }
    candidates.sort((a,b)=>Number(b.candidate)-Number(a.candidate) ||
        (a.candidate?b.estimatedEv-a.estimatedEv:b.probability-a.probability) || a.price-b.price || String(a.match.home_team).localeCompare(String(b.match.home_team)));
    const pick=candidates[0];
    return pick?{...pick,modelVersion:VERSION,phase:pick.candidate?'positive_market_trial':'exploration',
        reason:pick.candidate?'Testing a market/odds band with positive earlier flat returns; forward validation pending':'No established profitable market band; experimental learning pick'}:null;
}
function exists(db,table){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
function canReadFixtures(db) {return exists(db,'live_predictions') && ['kickoff_timestamp','scored_status','actual_score'].every(name=>db.prepare('PRAGMA table_info(live_predictions)').all().some(c=>c.name===name));}
function observations(db) {
    return exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE status IN ('won','lost') ORDER BY kickoff_timestamp DESC LIMIT 10000").all():[];
}
function record(db,seasonName) {
    if(!exists(db,'ml_pick_observations'))return 0;
    db.exec(`CREATE TABLE IF NOT EXISTS market_specialist_decisions(observation_id INTEGER PRIMARY KEY,policy_version TEXT NOT NULL,decision_json TEXT NOT NULL)`);
    const matches=db.prepare(`SELECT * FROM live_predictions lp WHERE season_name=? AND scored_status=0 AND actual_score IS NULL AND kickoff_timestamp>?
        AND NOT EXISTS(SELECT 1 FROM ml_pick_observations p WHERE p.engine='market_specialist' AND p.season_name=lp.season_name AND p.round_number=lp.round_number)`).all(seasonName,Date.now());
    const history=observations(db),rounds=new Map();
    for(const match of matches){const key=match.round_number+'|'+match.kickoff_timestamp;if(!rounds.has(key))rounds.set(key,[]);rounds.get(key).push(match);}
    const insert=db.prepare(`INSERT OR IGNORE INTO ml_pick_observations(engine,model_version,season_name,round_number,home_team,away_team,market,probability,implied_odd,fair_prob,kickoff_timestamp,match_time,recorded_at,publish_eligible)
        VALUES('market_specialist',@model_version,@season_name,@round_number,@home_team,@away_team,@market,@probability,@implied_odd,@fair_prob,@kickoff_timestamp,@match_time,@recorded_at,0)`);
    const meta=db.prepare('INSERT INTO market_specialist_decisions VALUES(?,?,?)');
    let count=0;
    db.transaction(()=>{for(const batch of rounds.values()) {
        const pick=choose(batch,history),now=Date.now();if(!pick || pick.match.kickoff_timestamp<=now)continue;
        const result=insert.run({...pick.match,model_version:VERSION,market:pick.market,probability:pick.probability*100,
            implied_odd:pick.price,fair_prob:pick.fair,match_time:pick.match.match_time||null,recorded_at:now});
        if(result.changes){count++;meta.run(result.lastInsertRowid,VERSION,JSON.stringify({phase:pick.phase,reason:pick.reason,profile:pick.profile||null,estimatedEv:pick.estimatedEv,observedAt:now}));}
    }})();
    return count;
}
function report(db) {
    const history=observations(db),now=Date.now();
    const future=canReadFixtures(db)?db.prepare('SELECT * FROM live_predictions WHERE kickoff_timestamp>? AND scored_status=0 AND actual_score IS NULL ORDER BY kickoff_timestamp LIMIT 100').all(now):[];
    const first=future[0],batch=first?future.filter(m=>m.kickoff_timestamp===first.kickoff_timestamp&&m.season_name===first.season_name):[];
    const pick=choose(batch,history);
    const recorded=exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE engine='market_specialist' AND status='pending' AND kickoff_timestamp>? ORDER BY kickoff_timestamp,id LIMIT 1").get(now):null;
    let decision=null;
    if(recorded && exists(db,'market_specialist_decisions')) {
        try{decision=JSON.parse(db.prepare('SELECT decision_json FROM market_specialist_decisions WHERE observation_id=?').get(recorded.id)?.decision_json);}catch{}
    }
    return {version:VERSION,status:'paper_validation',minOdds:2,publishEligible:false,
        description:'Bayesian market specialist: learns market/odds bands from earlier immutable engine outcomes. Positive market trials and exploration are paper observations; publication remains blocked.',
        profiles:profiles(history,now,first?features.scope(first):null).sort((a,b)=>Number(b.candidate)-Number(a.candidate)||b.n-a.n),
        nextPick:recorded?{home:recorded.home_team,away:recorded.away_team,market:recorded.market,odds:recorded.implied_odd,probability:recorded.probability,
            phase:decision?.phase||'exploration',reason:decision?.reason||'Immutable pre-kickoff learning observation',recorded:true}
            :pick?{home:pick.match.home_team,away:pick.match.away_team,market:pick.market,odds:pick.price,probability:pick.probability*100,phase:'preview',reason:'Preview awaiting immutable pre-kickoff capture',recorded:false}:null};
}
// Retired: preserve old decision metadata for Archive, never issue new picks.
module.exports={VERSION,band,profiles,choose,record:()=>0,report};
