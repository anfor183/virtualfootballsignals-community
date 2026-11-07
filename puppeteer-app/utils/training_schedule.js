'use strict';
const fs=require('fs');
const crypto=require('crypto');
function progress(db,lastId=0){
    const row=db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(id),0) AS maxId,
        COALESCE(MAX(kickoff_timestamp),0) AS maxKickoff,
        COALESCE(SUM(id > ?),0) AS newResults FROM live_predictions
        WHERE scored_status=1 AND actual_score IS NOT NULL`).get(lastId);
    return row;
}
function due(current,state,options={},now=Date.now()){
    const elapsed=now-(Date.parse(state.lastTrainedAt)||0);
    const cooldown=now-(Date.parse(state.lastTrainingAttemptAt)||0);
    const changed=current.maxId>(state.lastTrainedPredictionId||0);
    const minNew=Math.max(100,options.minNewMatches||200);
    const drift=!!options.drift;
    return !!options.force || cooldown>=5*60000 && changed && current.count>=2000 &&
        (current.newResults>=minNew || elapsed>=(options.intervalMinutes||60)*60000 || drift && current.newResults>=50);
}
function acquire(file){
    const token=crypto.randomUUID();
    try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'});return token;}
    catch(e){if(e.code!=='EEXIST')throw e;}
    let owner;
    try{owner=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch{if(Date.now()-fs.statSync(file).mtimeMs<30000)return null;}
    if(owner?.pid){try{process.kill(owner.pid,0);return null;}catch(e){if(e.code!=='ESRCH')return null;}}
    try{fs.unlinkSync(file);}catch{return null;}
    try{fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'});return token;}catch{return null;}
}
function release(file,token){
    try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file);}catch{}
}
module.exports={progress,due,acquire,release};
