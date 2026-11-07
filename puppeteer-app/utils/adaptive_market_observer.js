'use strict';
const fs = require('fs');
const path = require('path');
const { outcome } = require('./ai_best_market_features');
const predictor = require('./adaptive_market_predictor');
function exists(db) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ml_pick_observations' AND type='table'").get(); }
function ensure(db) {
    for (const table of ['ml_pick_observations', 'ml_policy_observations']) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY, engine TEXT NOT NULL, model_version TEXT NOT NULL,
        season_name TEXT NOT NULL, round_number INTEGER NOT NULL, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
        market TEXT NOT NULL, probability REAL NOT NULL, implied_odd REAL NOT NULL, fair_prob REAL NOT NULL,
        kickoff_timestamp INTEGER NOT NULL, match_time TEXT, recorded_at INTEGER NOT NULL,
        publish_eligible INTEGER NOT NULL, status TEXT DEFAULT 'pending', actual_score TEXT, actual_ht_score TEXT,
        UNIQUE(engine, season_name, round_number));
        CREATE INDEX IF NOT EXISTS idx_${table}_pending ON ${table}(status,engine);`);
}
function record(db, seasonName) {
    ensure(db);
    const pickStmt = db.prepare(`INSERT OR IGNORE INTO ml_pick_observations
        (engine,model_version,season_name,round_number,home_team,away_team,market,probability,implied_odd,
        fair_prob,kickoff_timestamp,match_time,recorded_at,publish_eligible)
        VALUES (@engine,@model_version,@season_name,@round_number,@home_team,@away_team,@market,@probability,
        @implied_odd,@fair_prob,@kickoff_timestamp,@match_time,@recorded_at,@publish_eligible)`);
    const policyStmt = db.prepare(`INSERT OR IGNORE INTO ml_policy_observations
        (engine,model_version,season_name,round_number,home_team,away_team,market,probability,implied_odd,
        fair_prob,kickoff_timestamp,match_time,recorded_at,publish_eligible)
        VALUES (@engine,@model_version,@season_name,@round_number,@home_team,@away_team,@market,@probability,
        @implied_odd,@fair_prob,@kickoff_timestamp,@match_time,@recorded_at,@publish_eligible)`);
    const inserts = {
        shadow: pickStmt,
        live: pickStmt,
        policy: policyStmt
    };
    let count=0;
    for (const engine of ['safest','ai_best','high_chance']) {
        if (!predictor.loadBundle(engine)) continue;
        const matches = db.prepare(`SELECT * FROM live_predictions lp WHERE season_name=?
            AND scored_status=0 AND actual_score IS NULL AND kickoff_timestamp>?
            AND NOT EXISTS (SELECT 1 FROM ml_pick_observations p WHERE p.engine=?
              AND p.season_name=lp.season_name AND p.round_number=lp.round_number)`).all(seasonName,Date.now(),engine);
        for (const pick of predictor.scoreMatches(db,matches,{engine,shadow:true,includePolicy:true})) {
            const observedAt=Date.now(); if (pick.match.kickoff_timestamp<=observedAt) continue;
            const insertStmt = inserts[pick.observationLane] || pickStmt;
            count += insertStmt.run({...pick.match, engine, model_version:pick.modelVersion, market:pick.market,
                probability:pick.prob, implied_odd:pick.impliedOdd, fair_prob:pick.bookmakerImpliedProb/100,
                recorded_at:observedAt, match_time:pick.match.match_time || null,
                publish_eligible:Number(pick.publishEligible)}).changes;
        }
    }
    count += require('./goals_engine').record(db,seasonName);
    return count;
}
function monitoring(db, engine, modelVersion) {
    if (!exists(db)) return {n:0,paused:false};
    const rows=db.prepare(`SELECT probability,implied_odd,fair_prob,status FROM ml_pick_observations
        WHERE engine=? AND model_version=? AND status IN ('won','lost') ORDER BY kickoff_timestamp DESC LIMIT 200`).all(engine,modelVersion);
    if (!rows.length) return {n:0,paused:false,model_version:modelVersion};
    const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
    const loss=(p,y)=>-Math.log(Math.max(1e-6,y?p:1-p));
    const winRate=mean(rows.map(r=>Number(r.status==='won'))), confidence=mean(rows.map(r=>r.probability/100));
    const ll=mean(rows.map(r=>loss(r.probability/100,r.status==='won')));
    const baseline=mean(rows.map(r=>loss(r.fair_prob,r.status==='won')));
    const paused=rows.length>=100 && (Math.abs(winRate-confidence)>(engine === 'safest' ? .07 : .12) || ll>baseline+.08 || engine==='safest' && winRate<.85);
    const policyExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ml_policy_observations'").get();
    const policyRows = policyExists ? db.prepare(`SELECT implied_odd,status,kickoff_timestamp FROM ml_policy_observations
        WHERE engine=? AND model_version=? AND status IN ('won','lost') ORDER BY kickoff_timestamp DESC LIMIT 5000`).all(engine,modelVersion)
        .filter(r => engine === 'safest' || require('./pick_policy').pickDecision(engine,r).allowed) : [];
    const forward = policySummary(policyRows);
    return {n:rows.length,win_rate:Number((winRate*100).toFixed(2)),mean_confidence:Number((confidence*100).toFixed(2)), ...forward,
        logloss:ll,bookmaker_logloss:baseline,paused,model_version:modelVersion,
        reason:paused?'Recent prospective results show calibration/performance drift; publication paused while retraining.':'Prospective monitoring active',
        updated_at:new Date().toISOString()};
}
function settle(db) {
    if (!exists(db)) return 0;
    ensure(db);
    let count=0;
    require('./goals35_engine').settle(db);
    require('./goals_engine').settle(db);
    const findResult=require('./observation_results').lookup(db);
    for (const table of ['ml_pick_observations','ml_policy_observations']) {
    const rows=db.prepare(`SELECT * FROM ${table} WHERE status='pending'`).all();
    const update=db.prepare(`UPDATE ${table} SET status=?,actual_score=?,actual_ht_score=? WHERE id=? AND status='pending'`);
    db.transaction(()=>{for(const r of rows){const result=findResult(r);if(!result)continue;const won=outcome(r.market,result.actual_score,result.actual_ht_score);
        if(won!==null)count+=update.run(won?'won':'lost',result.actual_score,result.actual_ht_score,r.id).changes;}})();
    }
    if(count) for(const engine of ['safest','ai_best','high_chance']){
        const version=predictor.loadBundle(engine)?.report.version;if(!version)continue;
        const value=monitoring(db,engine,version), file=path.join(__dirname,`${engine}_market_monitor.json`);
        const tmp=file+`.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);
    }
    if(count)require('./strategy_release').queueRefresh(db);
    return count;
}
function policySummary(rows) {
    const n=rows.length, days=new Map(); let sum=0,wins=0;
    for(const r of rows){const profit=r.status==='won'?r.implied_odd-1:-1;sum+=profit;wins+=Number(r.status==='won');
        const key=Math.floor((r.kickoff_timestamp+3600000)/86400000), g=days.get(key)||{profit:0,n:0};
        g.profit+=profit;g.n++;days.set(key,g);}
    const groups=[...days.values()];let lower=null;
    if(groups.length>=2){const draws=[];let seed=42;
        for(let i=0;i<2000;i++){let profit=0,count=0;for(let j=0;j<groups.length;j++){
            seed=(Math.imul(seed,1664525)+1013904223)>>>0;const g=groups[Math.floor(seed/4294967296*groups.length)];profit+=g.profit;count+=g.n;}
            draws.push(profit/count*100);}
        draws.sort((a,b)=>a-b);lower=draws[100];}
    return {qualified_n:n,qualified_days:days.size,qualified_win_rate:n?Number((wins/n*100).toFixed(2)):null,
        qualified_roi:n?Number((sum/n*100).toFixed(2)):null,qualified_roi_lower_bound:lower,
        forward_validation_passed:n>=100&&days.size>=5&&lower>0&&wins/n>=.7};
}
module.exports={record,settle,monitoring,policySummary,exists};
