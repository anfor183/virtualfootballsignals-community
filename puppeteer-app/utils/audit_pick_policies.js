'use strict';
// Retrospective reference replay, deliberately separate from trained-model OOS
// and prospective ledgers. No threshold search is performed on these results.
const Database=require('better-sqlite3'),fs=require('fs'),path=require('path');
const features=require('./ai_best_market_features');
const {pickDecision}=require('./pick_policy');
async function audit(dbPath,output){
    const {compareStrategies}=await import('./strategy_backtest.mjs');
    let ai={};try{ai=JSON.parse(fs.readFileSync(path.join(__dirname,'../browser-config.json'),'utf8')).ai||{};}catch{}
    const db=new Database(dbPath,{readonly:true}),policy=features.enginePolicy('high_chance',ai), rounds=new Map();
    const query=db.prepare(`SELECT id,season_name,round_number,kickoff_timestamp,predicted_probs,bookmaker_odds,
        actual_score,actual_ht_score FROM live_predictions WHERE scored_status=1 AND scored_with_prediction=1
        AND actual_score IS NOT NULL AND bookmaker_odds IS NOT NULL AND kickoff_timestamp>0
        ORDER BY kickoff_timestamp,id`);
    let sourceRows=0;
    for(const row of query.iterate()){
        sourceRows++;
        const key=`${features.scope(row)}|${row.kickoff_timestamp}|${row.round_number}`;
        for(const c of features.candidates(row,[],policy.minOdds,policy)){
            if(c.label===null)continue;
            const probability=c.features[0];
            if(!Number.isFinite(probability)||probability<=0||probability>=1)continue;
            const old=rounds.get(key);
            if(!old||probability>old.probability)rounds.set(key,{id:row.id,kickoff_timestamp:row.kickoff_timestamp,
                implied_odd:c.price,status:c.label?'won':'lost',probability});
        }
    }
    db.close();
    const rows=[...rounds.values()],day=rows.filter(r=>pickDecision('high_chance',r).allowed),night=rows.filter(r=>!pickDecision('high_chance',r).allowed);
    const disciplined=rows.filter(r=>r.probability>=.75&&r.probability*r.implied_odd-1>=.03);
    const combined=disciplined.filter(r=>pickDecision('high_chance',r).allowed);
    const result={generatedAt:new Date().toISOString(),sourceRows,reference:'Archived High Chance raw-forecast baseline; not the new ML model',
        presetRule:'Probability >=75%, EV >=3%, actual odds 1.65–3.50, configured blocked markets retained',
        limitations:['Archived forecasts lack immutable recorded_at timestamps, so this replay is not forward evidence.',
            'Day/night cohorts differ. Differences do not establish that time of day causes an edge.',
            'This reference uses fixed thresholds; no thresholds were selected from its outcomes.'],
        all:compareStrategies(rows),midnightPause:compareStrategies(day),overnight:compareStrategies(night),
        disciplined:compareStrategies(disciplined),combined:compareStrategies(combined),
        verdict:'Neither rule is universally proven. Require independent model audits and qualified forward results before profitability claims.'};
    fs.writeFileSync(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({sourceRows,all:result.all.fixed,day:result.midnightPause.fixed,night:result.overnight.fixed,
        disciplined:result.disciplined.fixed,combined:result.combined.fixed},null,2));
    return result;
}
module.exports={audit};
if(require.main===module)audit(process.argv[2],process.argv[3]||path.join(__dirname,'policy_evidence_runtime.json')).catch(e=>{console.error(e.message);process.exitCode=1;});
