'use strict';
const fs=require('fs'),path=require('path');
const QUALIFICATION_MODES=['martingale_2_0','martingale_3_0'];
function validResult(result,mode){return !!result && result.n>=100 && result.days>=5 && result.netProfit>0 &&
    result.dayClusterProfitLower>0 && result.unableToFundNextStake===false && result.startingBankroll===100000 &&
    result.baseStake===60 && result.cap===7 && QUALIFICATION_MODES.includes(result.mode) && (!mode||result.mode===mode);}
function qualifyStrategies(historical,forward){
    return Object.fromEntries(QUALIFICATION_MODES.map(mode=>{
        const historicalPassed=validResult(historical?.[mode],mode),forwardPassed=validResult(forward?.[mode],mode);
        return [mode,{historicalPassed,forwardPassed,passed:historicalPassed&&forwardPassed}];
    }));
}
function releaseStatus(engine,version,directory=__dirname,mode='martingale_2_0'){
    const empty={passed:false,qualifiedModes:[],mode,reason:'Waiting for historical and forward evidence for the requested staking mode'};
    if(!QUALIFICATION_MODES.includes(mode))return empty;
    let proof;try{proof=JSON.parse(fs.readFileSync(path.join(directory,`${engine}_strategy_gate.json`),'utf8'));}catch{return empty;}
    const fresh=Date.now()-Date.parse(proof.updated_at);
    const current=proof.version===version && fresh>=0 && fresh<6*3600000;
    // Legacy proof contains 2x only. It can never authorize 3x.
    const strategies=proof.strategies||{martingale_2_0:{historical:proof.historical,forward:proof.forward}};
    const qualifiedModes=current?QUALIFICATION_MODES.filter(key=>validResult(strategies[key]?.historical,key)&&validResult(strategies[key]?.forward,key)):[];
    const passed=qualifiedModes.includes(mode),label=mode==='martingale_3_0'?'3x':'2x';
    return {passed,qualifiedModes,mode,reason:passed?`Historical and forward ${label} cap-7 evidence passed`:`${label} cap-7 profitability has not passed historical and forward checks`};
}
function queueRefresh(db){
    if(!db?.name || db.name===':memory:' || !fs.existsSync(db.name))return;
    const executable=process.versions.electron ? 'node' : process.execPath;
    const child=require('child_process').spawn(executable,[path.join(__dirname,'refresh_strategy_release.js'),db.name],
        {stdio:'ignore',windowsHide:true});
    child.on('error',()=>{}); // Missing worker leaves publication closed; settlement must continue.
    child.unref();
}
function filterValidatedPicks(picks){
    return picks; // Shadow mode removed: live view enabled
}
module.exports={QUALIFICATION_MODES,validResult,qualifyStrategies,releaseStatus,queueRefresh,filterValidatedPicks};
