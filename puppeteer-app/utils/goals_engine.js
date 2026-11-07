'use strict';
// One goals engine, one immutable choice and one staking cycle per round.
const learner=require('./goals35_engine'),features=require('./ai_best_market_features');
const VERSION='goals-combined-calibrated-v1',ENGINE='goals',LINES=[2.5,3.5];
const exists=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const summary=m=>({rows:m.rows,blend:m.blend,validationN:m.validationN,validationLoss:m.validationLoss,bookmakerLoss:m.bookmakerLoss});
function choose(matches,rows,at=Date.now()) {
    const future=matches.filter(m=>Number(m.kickoff_timestamp)>at);
    if(!future.length)return {pick:null,candidates:[],models:{}};
    const scope=features.scope(future[0]),before=Math.min(at,...future.map(m=>Number(m.kickoff_timestamp)));
    const models=Object.fromEntries(LINES.map(line=>[line,learner.learn(rows,before,scope,line)])),candidates=[];
    for(const match of future.filter(m=>features.scope(m)===scope)) {
        const totals=LINES.map(line=>{
            const price=learner.quotes(match,line);if(!price)return null;
            const model=models[line],over=Math.max(.01,Math.min(.99,price.fairOver+model.blend*learner.adjustment(model,price.fairOver,match)));
            return {match,line,price,over};
        }).filter(Boolean);
        // P(4+ goals) cannot exceed P(3+ goals). Pool crossed estimates.
        if(totals.length===2&&totals[1].over>totals[0].over)totals[0].over=totals[1].over=(totals[0].over+totals[1].over)/2;
        candidates.push(...totals);
    }
    const choices=candidates.flatMap(c=>['over','under'].map(side=>{
        const p=side==='over'?c.over:1-c.over,price=c.price[side];
        return {engine:ENGINE,market:`${side==='over'?'Over':'Under'} ${c.line} Goals`,match:c.match,line:c.line,
            probability:p*100,price,fair:side==='over'?c.price.fairOver:1-c.price.fairOver,estimatedReturn:p*price-1};
    }));
    // Compare learned chance with the quoted payout. A higher payout alone is not an edge.
    choices.sort((a,b)=>b.estimatedReturn-a.estimatedReturn||b.probability-a.probability||a.market.localeCompare(b.market)||
        String(a.match.home_team).localeCompare(String(b.match.home_team))||String(a.match.away_team).localeCompare(String(b.match.away_team)));
    return {pick:choices[0]||null,candidates,models:Object.fromEntries(LINES.map(line=>[line,summary(models[line])]))};
}
function ensure(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS goals_market_candidates(
        id INTEGER PRIMARY KEY,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,
        goal_line REAL,recorded_at INTEGER,over_odd REAL,under_odd REAL,fair_over REAL,over_probability REAL,model_version TEXT,
        status TEXT DEFAULT 'pending',actual_score TEXT,settled_at INTEGER,
        UNIQUE(season_name,round_number,home_team,away_team,kickoff_timestamp,goal_line));
        CREATE INDEX IF NOT EXISTS idx_goals_market_pending ON goals_market_candidates(status,kickoff_timestamp);
        CREATE TABLE IF NOT EXISTS goals_engine_decisions(observation_id INTEGER PRIMARY KEY,model_version TEXT,decision_json TEXT);`);
}
function observations(db) {
    const seed=exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE market IN ('Over 2.5 Goals','Under 2.5 Goals','Over 3.5 Goals','Under 3.5 Goals') AND status IN ('won','lost') ORDER BY kickoff_timestamp DESC LIMIT 10000").all():[];
    const old=exists(db,'goals35_candidates')?db.prepare("SELECT *,3.5 AS goal_line FROM goals35_candidates WHERE status='settled' ORDER BY kickoff_timestamp DESC LIMIT 5000").all():[];
    const own=exists(db,'goals_market_candidates')?db.prepare("SELECT * FROM goals_market_candidates WHERE status='settled' ORDER BY kickoff_timestamp DESC LIMIT 10000").all():[];
    return [...seed,...old,...own];
}
function record(db,seasonName) {
    if(!exists(db,'ml_pick_observations'))return 0;ensure(db);
    const matches=db.prepare('SELECT * FROM live_predictions WHERE season_name=? AND scored_status=0 AND actual_score IS NULL AND kickoff_timestamp>? ORDER BY kickoff_timestamp,round_number,home_team,away_team').all(seasonName,Date.now());
    const groups=new Map();for(const m of matches){const key=m.round_number+'|'+m.kickoff_timestamp;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
    const history=observations(db),insertCandidate=db.prepare(`INSERT OR IGNORE INTO goals_market_candidates(season_name,round_number,home_team,away_team,kickoff_timestamp,goal_line,recorded_at,over_odd,under_odd,fair_over,over_probability,model_version)
        VALUES(@season_name,@round_number,@home_team,@away_team,@kickoff_timestamp,@goal_line,@recorded_at,@over_odd,@under_odd,@fair_over,@over_probability,@model_version)`);
    const insert=db.prepare(`INSERT OR IGNORE INTO ml_pick_observations(engine,model_version,season_name,round_number,home_team,away_team,market,probability,implied_odd,fair_prob,kickoff_timestamp,match_time,recorded_at,publish_eligible)
        VALUES(@engine,@model_version,@season_name,@round_number,@home_team,@away_team,@market,@probability,@implied_odd,@fair_prob,@kickoff_timestamp,@match_time,@recorded_at,0)`);
    let count=0;
    db.transaction(()=>{for(const batch of groups.values()){
        const result=choose(batch,history),now=Date.now();
        for(const c of result.candidates)if(c.match.kickoff_timestamp>now)insertCandidate.run({...c.match,goal_line:c.line,recorded_at:now,over_odd:c.price.over,under_odd:c.price.under,fair_over:c.price.fairOver,over_probability:c.over,model_version:VERSION});
        const pick=result.pick;if(!pick||pick.match.kickoff_timestamp<=now)continue;
        const added=insert.run({...pick.match,engine:ENGINE,model_version:VERSION,market:pick.market,probability:pick.probability,implied_odd:pick.price,fair_prob:pick.fair,match_time:pick.match.match_time||null,recorded_at:now});
        if(added.changes){count++;db.prepare('INSERT INTO goals_engine_decisions VALUES(?,?,?)').run(added.lastInsertRowid,VERSION,JSON.stringify({models:result.models,estimatedReturn:pick.estimatedReturn,observedAt:now}));}
    }})();return count;
}
function settle(db) {
    if(!exists(db,'goals_market_candidates'))return 0;
    const find=require('./observation_results').lookup(db),update=db.prepare("UPDATE goals_market_candidates SET status='settled',actual_score=?,settled_at=? WHERE id=? AND status='pending'");let count=0;
    db.transaction(()=>{for(const row of db.prepare("SELECT * FROM goals_market_candidates WHERE status='pending'").all()){
        const result=find({...row,market:`Over ${row.goal_line} Goals`});if(result)count+=update.run(result.actual_score,Date.now(),row.id).changes;
    }})();return count;
}
function report(db) {
    const r=exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE engine=? AND status='pending' AND kickoff_timestamp>? ORDER BY kickoff_timestamp,id LIMIT 1").get(ENGINE,Date.now()):null;
    return {version:VERSION,status:'paper_validation',next:r?{market:r.market,home:r.home_team,away:r.away_team,odds:r.implied_odd,probability:r.probability,recordedAt:r.recorded_at}:null,
        samples:exists(db,'goals_market_candidates')?db.prepare("SELECT COUNT(*) total,COALESCE(SUM(status='settled'),0) settled FROM goals_market_candidates").get():{total:0,settled:0}};
}
module.exports={VERSION,ENGINE,LINES,choose,record,settle,report,observations};
