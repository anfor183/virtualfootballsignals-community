'use strict';
const path=require('path'),Database=require('better-sqlite3');
const schedule=require('./training_schedule');
const lock=path.join(__dirname,'strategy_release.lock');
const token=schedule.acquire(lock);
if(token)(async()=>{
    let db;
    try{db=new Database(process.argv[2],{readonly:true});await require('./strategy_evidence').getStrategyEvidence(db);}
    finally{if(db)db.close();schedule.release(lock,token);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
