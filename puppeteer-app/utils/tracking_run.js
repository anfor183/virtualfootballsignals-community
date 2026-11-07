'use strict';
function activeRun(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tracking_runs'").get()) return null;
    return db.prepare('SELECT * FROM tracking_runs ORDER BY started_at DESC LIMIT 1').get() || null;
}
function startRun(db, {name='Adaptive engines v2',startedAt=Date.now(),version='high-chance-adaptive-v2'} = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS tracking_runs (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,started_at INTEGER NOT NULL,system_version TEXT NOT NULL,
        published_after_id INTEGER NOT NULL,bankroll REAL NOT NULL,base_stake REAL NOT NULL)`);
    const id=`${version}-${startedAt}`;
    const max=db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM ai_best_picks_history').get().id;
    db.prepare('INSERT INTO tracking_runs VALUES (?,?,?,?,?,?,?)').run(id,name,startedAt,version,max,100000,60);
    return activeRun(db);
}
function resetRun(db,expectedId,now=Date.now()) {
    return db.transaction(()=>{
        const current=activeRun(db);
        if(current && current.id!==expectedId)return current;
        return startRun(db,{name:'New tracking period',version:'user-tracking-reset-v1',
            startedAt:Math.max(now,(current?.started_at||0)+1)});
    })();
}
module.exports={activeRun,startRun,resetRun};
