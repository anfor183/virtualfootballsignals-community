'use strict';
const fs=require('fs'),path=require('path');
const predictor=require('./adaptive_market_predictor');
const {pickDecision}=require('./pick_policy');
const DEFAULT_TEST={bankroll:100000,baseStake:60};
const {QUALIFICATION_MODES,qualifyStrategies}=require('./strategy_release');
function attachQualification(result){
    result.strategyQualification=qualifyStrategies(result.historical?.qualified,result.forward?.qualified);
    result.qualifiedStakingModes=QUALIFICATION_MODES.filter(mode=>result.strategyQualification[mode].passed);
    result.twoXProfitabilityProven=result.strategyQualification.martingale_2_0.passed;
    result.threeXProfitabilityProven=result.strategyQualification.martingale_3_0.passed;
    result.profitabilityProven=result.qualifiedStakingModes.length>0;
    result.verdict=result.profitabilityProven?`Evidence criteria passed only for: ${result.qualifiedStakingModes.join(', ')}`:
        'Neither 2x nor 3x has passed its own historical and forward checks; experimental results do not authorize publication';
    return result;
}
function hasTable(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name);}
function rowsFromAudit(rows,filter){return rows.filter(filter).map((r,i)=>({id:i,kickoff_timestamp:r.kickoff,
    implied_odd:r.price,status:r.won?'won':'lost'}));}
async function engineEvidence(db,engine){
    const {compareStrategies}=await import('./strategy_backtest.mjs');
    const bundle=predictor.loadBundle(engine);
    const compare=rows=>compareStrategies(rows,DEFAULT_TEST);
    if(!bundle)return {engine,available:false};
    const auditPath=path.join(path.dirname(bundle.model),'audit_picks.json');
    let audit=[];try{audit=JSON.parse(fs.readFileSync(auditPath,'utf8'));}catch{}
    const raw=rowsFromAudit(audit,r=>r.shadow!==false), qualified=rowsFromAudit(audit,r=>r.qualified);
    const unrestricted=rowsFromAudit(audit,r=>r.qualified_without_midnight);
    const read=(table,version)=>!hasTable(db,table)?[]:db.prepare(`SELECT * FROM ${table}
        WHERE engine=? ${version?'AND model_version=?':''} ORDER BY kickoff_timestamp,id`).all(...[engine,...(version?[version]:[])]);
    const trackingRun=require('./tracking_run').activeRun(db);
    const fresh=rows=>rows.filter(r=>r.recorded_at>=(trackingRun?.started_at||0));
    const current=fresh(read('ml_pick_observations',bundle.report.version));
    const all=read('ml_pick_observations');
    const policy=fresh(read('ml_policy_observations',bundle.report.version));
    const day=rows=>rows.filter(r=>pickDecision(engine,r).allowed);
    const result={engine,available:true,version:bundle.report.version,
        historical:{shadow:compare(raw),daytimeShadow:compare(day(raw)),qualified:compare(qualified),
            qualifiedWithoutMidnight:compare(unrestricted)},
        forward:{shadow:compare(current),daytimeShadow:compare(day(current)),qualified:compare(day(policy)),
            qualifiedWithoutMidnight:compare(policy),pending:current.filter(r=>r.status==='pending').length},
        forwardCampaign:{shadow:compare(all),versions:[...new Set(all.map(r=>r.model_version))]},
        historicalAudit:bundle.report.audit, historicalReady:bundle.report.ready_for_deployment};
    return attachQualification(result);
}
async function goalsEvidence(db){
    const {compareStrategies}=await import('./strategy_backtest.mjs'),goals=require('./goals_engine');
    const rows=hasTable(db,'ml_pick_observations')?db.prepare('SELECT * FROM ml_pick_observations WHERE engine=? AND model_version=? ORDER BY kickoff_timestamp,id').all(goals.ENGINE,goals.VERSION):[];
    const compare=rows=>compareStrategies(rows,DEFAULT_TEST),empty=()=>({shadow:compare([]),qualified:compare([])});
    return attachQualification({engine:'goals',available:true,version:goals.VERSION,historical:empty(),historicalReady:false,historicalAuditAvailable:false,
        forward:{shadow:compare(rows),qualified:compare([]),pending:rows.filter(r=>r.status==='pending').length},
        qualificationNote:'No untouched historical audit or qualified-policy cohort exists yet. These are experimental combined-goals selections.'});
}
async function getStrategyEvidence(db){
    const engines={};for(const engine of ['safest','high_chance','ai_best'])engines[engine]=await engineEvidence(db,engine);
    engines.goals=await goalsEvidence(db);
    let policyReplay=null;try{policyReplay=JSON.parse(fs.readFileSync(path.join(__dirname,'policy_evidence_runtime.json'),'utf8'));}catch{}
    // Derived release evidence is version-bound and refreshed after settlement.
    // Reading the dashboard cannot turn a losing replay into permission to publish.
    for(const [engine,value] of Object.entries(engines))if(value.available){
        const file=path.join(__dirname,`${engine}_strategy_gate.json`),tmp=file+`.${process.pid}.tmp`;
        fs.writeFileSync(tmp,JSON.stringify({version:value.version,updated_at:new Date().toISOString(),
            strategies:Object.fromEntries(QUALIFICATION_MODES.map(mode=>[mode,{historical:value.historical.qualified[mode],forward:value.forward.qualified[mode]}]))}));
        fs.renameSync(tmp,file);
    }
    return {generatedAt:new Date().toISOString(),currency:'NGN',...DEFAULT_TEST,cap:7,qualificationModes:QUALIFICATION_MODES,qualificationRule:'either_mode_independently',engines,policyReplay,trackingRun:require('./tracking_run').activeRun(db),
        assumptions:['Each engine has its own independent bankroll; results are not a combined portfolio.',
            'Captured odds only. Sequential settlement before the next stake; execution timing/slippage are not verified.',
            'Pending matches are excluded. No added credit or bankroll replenishment.',
            'Seven bets per losing cycle, then reset to base. A win resets immediately.',
            'Day-cluster bounds describe this sample; neither historical nor forward success guarantees future profit.']};
}
module.exports={getStrategyEvidence,engineEvidence,goalsEvidence,attachQualification,DEFAULT_TEST};
if(require.main===module){(async()=>{const D=require('better-sqlite3');const db=new D(process.argv[2],{readonly:true});
    const result=await getStrategyEvidence(db);db.close();const out=process.argv[3];
    if(out)fs.writeFileSync(out,JSON.stringify(result,null,2));else console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});}
