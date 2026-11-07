'use strict';
// A dedicated binary goal model: Over 3.5 means at least four goals;
// Under 3.5 means zero through three. Side probabilities are complements.
const features=require('./ai_best_market_features');
const VERSION='goals35-bayes-calibrated-v1';
const SIDES={over35:'Over 3.5 Goals',under35:'Under 3.5 Goals'};
const exists=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const score=s=>/^\d+:\d+$/.test(s||'')?s.split(':').map(Number):null;
const identity=r=>[features.scope(r),r.kickoff_timestamp,r.home_team,r.away_team].join('|');
function quotes(match,line=3.5) {
    let odds=match.bookmaker_odds;
    try{if(typeof odds==='string')odds=JSON.parse(odds);}catch{return null;}
    const key=String(line).replace('.','');
    const over=Number(odds?.['over'+key]),under=Number(odds?.['under'+key]);
    if(!(Number.isFinite(over)&&over>1&&Number.isFinite(under)&&under>1))return null;
    return {over,under,fairOver:(1/over)/(1/over+1/under)};
}
function trainingRows(rows,before,scope,line=3.5) {
    const grouped=new Map();
    for(const r of rows) {
        const ft=score(r.actual_score),at=Number(r.kickoff_timestamp),recorded=Number(r.recorded_at);
        if(!ft || !['won','lost','settled'].includes(r.status) || !(recorded<at&&at<before) ||
            r.settled_at && r.settled_at>before || features.scope(r)!==scope)continue;
        if(r.fair_over!==undefined && Number(r.goal_line??3.5)!==line)continue;
        let fair=Number(r.fair_over);
        if(r.fair_over===undefined) {
            if(![`Over ${line} Goals`,`Under ${line} Goals`].includes(r.market))continue;
            fair=r.market===`Over ${line} Goals`?Number(r.fair_prob):1-Number(r.fair_prob);
        }
        if(!(fair>0&&fair<1))continue;
        const key=identity(r),row={...r,fairOver:fair,y:Number(ft[0]+ft[1]>line)};
        if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);
    }
    return [...grouped.values()].filter(values=>new Set(values.map(r=>r.y)).size===1)
        .map(values=>values.sort((a,b)=>a.recorded_at-b.recorded_at)[0])
        .sort((a,b)=>a.kickoff_timestamp-b.kickoff_timestamp).slice(-1000);
}
function fit(rows) {
    const buckets=new Map(),teams=new Map(),all={weight:0,residual:0};
    const add=(map,key,w,r)=>{const v=map.get(key)||{weight:0,residual:0};v.weight+=w;v.residual+=w*r;map.set(key,v);};
    rows.forEach((row,i)=>{
        const w=2**(-(rows.length-1-i)/100),r=row.y-row.fairOver;
        all.weight+=w;all.residual+=w*r;add(buckets,Math.floor(row.fairOver*10),w,r);
        add(teams,row.home_team,w,r);add(teams,row.away_team,w,r);
    });
    return {rows:rows.length,all,buckets,teams};
}
function adjustment(model,fair,match) {
    const bucket=model.buckets.get(Math.floor(fair*10)),global=bucket?.weight>=10?bucket:model.all;
    const a=model.teams.get(match.home_team)||{weight:0,residual:0},b=model.teams.get(match.away_team)||{weight:0,residual:0};
    const league=global.residual/(global.weight+20),team=(a.residual+b.residual)/(a.weight+b.weight+40);
    return .75*league+.25*team;
}
function learn(rows,before,scope,line=3.5) {
    const history=trainingRows(rows,before,scope,line);
    let blend=1,validationN=0,validationLoss=null,bookmakerLoss=null;
    if(history.length>=100) {
        const cutoff=history[Math.floor(history.length*.8)].kickoff_timestamp;
        const train=history.filter(r=>r.kickoff_timestamp<cutoff),validation=history.filter(r=>r.kickoff_timestamp>=cutoff);
        const fitted=fit(train),loss=(p,y)=>-Math.log(Math.max(1e-6,y?p:1-p));
        const trials=[0,.25,.5,1].map(weight=>({weight,loss:validation.reduce((s,r)=>s+loss(Math.max(.01,Math.min(.99,r.fairOver+weight*adjustment(fitted,r.fairOver,r))),r.y),0)/validation.length}));
        trials.sort((a,b)=>a.loss-b.loss||a.weight-b.weight);blend=trials[0].weight;
        validationN=validation.length;validationLoss=trials[0].loss;bookmakerLoss=trials.find(t=>t.weight===0).loss;
    }
    return {...fit(history),blend,validationN,validationLoss,bookmakerLoss};
}
function choose(matches,rows,at=Date.now()) {
    if(!matches.length)return {picks:{},model:{rows:0}};
    const scope=features.scope(matches[0]),before=Math.min(at,...matches.map(r=>Number(r.kickoff_timestamp))),model=learn(rows,before,scope);
    const candidates=matches.filter(r=>features.scope(r)===scope).map(match=>{
        const price=quotes(match);if(!price)return null;
        const over=Math.max(.01,Math.min(.99,price.fairOver+model.blend*adjustment(model,price.fairOver,match)));
        return {match,price,over,under:1-over};
    }).filter(Boolean);
    const picks={};
    for(const [engine,market] of Object.entries(SIDES)) {
        const side=engine==='over35'?'over':'under';
        const ranked=[...candidates].sort((a,b)=>b[side]-a[side]||String(a.match.home_team).localeCompare(String(b.match.home_team))||String(a.match.away_team).localeCompare(String(b.match.away_team)));
        if(ranked[0]) {const c=ranked[0];picks[engine]={engine,market,match:c.match,probability:c[side]*100,price:c.price[side],fair:side==='over'?c.price.fairOver:1-c.price.fairOver};}
    }
    return {picks,candidates,model:{rows:model.rows,blend:model.blend,validationN:model.validationN,validationLoss:model.validationLoss,bookmakerLoss:model.bookmakerLoss}};
}
function ensure(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS goals35_candidates (
        id INTEGER PRIMARY KEY,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,kickoff_timestamp INTEGER,
        recorded_at INTEGER,over_odd REAL,under_odd REAL,fair_over REAL,over_probability REAL,model_version TEXT,
        status TEXT DEFAULT 'pending',actual_score TEXT,settled_at INTEGER,
        UNIQUE(season_name,round_number,home_team,away_team,kickoff_timestamp));
        CREATE INDEX IF NOT EXISTS idx_goals35_candidates_pending ON goals35_candidates(status,kickoff_timestamp);
        CREATE TABLE IF NOT EXISTS goals35_decisions(observation_id INTEGER PRIMARY KEY,model_version TEXT,decision_json TEXT);`);
}
function observations(db) {
    const seed=exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE market IN ('Over 3.5 Goals','Under 3.5 Goals') AND status IN ('won','lost') ORDER BY kickoff_timestamp DESC LIMIT 5000").all():[];
    const own=exists(db,'goals35_candidates')?db.prepare("SELECT * FROM goals35_candidates WHERE status='settled' ORDER BY kickoff_timestamp DESC LIMIT 5000").all():[];
    return [...seed,...own];
}
function record(db,seasonName) {
    if(!exists(db,'ml_pick_observations'))return 0;ensure(db);
    const matches=db.prepare("SELECT * FROM live_predictions WHERE season_name=? AND scored_status=0 AND actual_score IS NULL AND kickoff_timestamp>?").all(seasonName,Date.now());
    const groups=new Map();for(const m of matches){const key=m.round_number+'|'+m.kickoff_timestamp;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(m);}
    const history=observations(db),insertCandidate=db.prepare(`INSERT OR IGNORE INTO goals35_candidates(season_name,round_number,home_team,away_team,kickoff_timestamp,recorded_at,over_odd,under_odd,fair_over,over_probability,model_version)
        VALUES(@season_name,@round_number,@home_team,@away_team,@kickoff_timestamp,@recorded_at,@over_odd,@under_odd,@fair_over,@over_probability,@model_version)`);
    const insert=db.prepare(`INSERT OR IGNORE INTO ml_pick_observations(engine,model_version,season_name,round_number,home_team,away_team,market,probability,implied_odd,fair_prob,kickoff_timestamp,match_time,recorded_at,publish_eligible)
        VALUES(@engine,@model_version,@season_name,@round_number,@home_team,@away_team,@market,@probability,@implied_odd,@fair_prob,@kickoff_timestamp,@match_time,@recorded_at,0)`);
    let count=0;
    db.transaction(()=>{for(const batch of groups.values()) {
        const result=choose(batch,history),now=Date.now();
        for(const c of result.candidates||[])if(c.match.kickoff_timestamp>now)insertCandidate.run({...c.match,recorded_at:now,over_odd:c.price.over,under_odd:c.price.under,fair_over:c.price.fairOver,over_probability:c.over,model_version:VERSION});
        for(const pick of Object.values(result.picks)) {
            if(pick.match.kickoff_timestamp<=now)continue;
            const added=insert.run({...pick.match,engine:pick.engine,model_version:VERSION,market:pick.market,probability:pick.probability,implied_odd:pick.price,fair_prob:pick.fair,match_time:pick.match.match_time||null,recorded_at:now});
            if(added.changes){count++;db.prepare('INSERT INTO goals35_decisions VALUES(?,?,?)').run(added.lastInsertRowid,VERSION,JSON.stringify({model:result.model,observedAt:now}));}
        }
    }})();return count;
}
function settle(db) {
    if(!exists(db,'goals35_candidates'))return 0;
    const find=require('./observation_results').lookup(db),update=db.prepare("UPDATE goals35_candidates SET status='settled',actual_score=?,settled_at=? WHERE id=? AND status='pending'");let count=0;
    db.transaction(()=>{for(const row of db.prepare("SELECT * FROM goals35_candidates WHERE status='pending'").all()) {
        const result=find({...row,market:SIDES.over35});if(result)count+=update.run(result.actual_score,Date.now(),row.id).changes;
    }})();return count;
}
function report(db) {
    const next={};
    for(const [engine,market] of Object.entries(SIDES)) {
        const r=exists(db,'ml_pick_observations')?db.prepare("SELECT * FROM ml_pick_observations WHERE engine=? AND status='pending' AND kickoff_timestamp>? ORDER BY kickoff_timestamp,id LIMIT 1").get(engine,Date.now()):null;
        next[engine]=r?{market,home:r.home_team,away:r.away_team,odds:r.implied_odd,probability:r.probability,recordedAt:r.recorded_at}:null;
    }
    return {version:VERSION,status:'paper_validation',description:'Dedicated adaptive 3.5-goal classifier with separate Over 3.5 and Under 3.5 trials. Learns recent league/team forecast errors, calibrates its learned adjustment on earlier rounds, and freezes both side choices before kickoff.',
        samples:exists(db,'goals35_candidates')?db.prepare("SELECT COUNT(*) total,SUM(status='settled') settled FROM goals35_candidates").get():{total:0,settled:0},next};
}
// The former two-side writer is retired. Keep learning/settlement helpers for archives.
module.exports={VERSION,SIDES,quotes,trainingRows,learn,adjustment,choose,record:()=>0,settle,report};
