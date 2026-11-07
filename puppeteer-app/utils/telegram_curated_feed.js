'use strict';
const path=require('path'),crypto=require('crypto'),Database=require('better-sqlite3');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const escape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const engineNames={safest:'Safest',high_value:'High Chance',ai_best_pick:'AI Best'};
function ensure(db){db.exec(`CREATE TABLE IF NOT EXISTS telegram_feed_events(
 event_key TEXT PRIMARY KEY,bot_key TEXT,provider TEXT,source_db TEXT,pick_json TEXT,created_at INTEGER,state TEXT);
 CREATE INDEX IF NOT EXISTS idx_telegram_feed_quota ON telegram_feed_events(bot_key,created_at);
 CREATE TABLE IF NOT EXISTS telegram_feed_deliveries(
 id INTEGER PRIMARY KEY,event_key TEXT,target TEXT,state TEXT,message_id INTEGER,edit_state TEXT DEFAULT 'pending',edit_at INTEGER DEFAULT 0,edit_attempts INTEGER DEFAULT 0,
 UNIQUE(event_key,target));`);}
function ledger(options={}){
 if(options.deliveryDb){ensure(options.deliveryDb);return {db:options.deliveryDb,close:()=>{}};}
 const db=new Database(path.resolve(__dirname,'../databases/telegram_delivery.db'),{timeout:5000});db.pragma('journal_mode=WAL');db.pragma('busy_timeout=5000');ensure(db);return {db,close:()=>db.close()};
}
function recipients(config,now=Date.now()){
 const target=config.targetChannel||'main',ids=[];
 if(target==='main'||target==='both')ids.push(config.chatId);
 if(target==='vip'||target==='both')ids.push(config.vipGroupId);
 for(const s of config.subscribers||[])if(s.status==='active'&&s.chatId&&(!s.expiryDate||Date.parse(s.expiryDate)>now))ids.push(s.chatId);
 return [...new Set(ids.filter(Boolean).map(String))];
}
const namespace=config=>hash(config.botToken);
const sourceName=db=>db.name&&db.name!==':memory:'?path.resolve(db.name):':memory:';
const eventKey=(config,pick)=>hash([namespace(config),config.provider,pick.season_name,pick.round_number,pick.kickoff_timestamp].join('|'));
function render(pick,config,result=null){
 const time=new Date(Number(pick.kickoff_timestamp)).toLocaleString('en-GB',{timeZone:'Africa/Lagos',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});
 const status=result?`${{won:'✅ Won',lost:'❌ Lost',void:'↩ Void'}[result.status]} · Score ${escape(result.actual_score||'—')}`:'⏳ Awaiting result';
 return `<b>${escape((config.channelTitle||'Nexus Signals').slice(0,90))}</b>\n\n<b>${escape(pick.home_team)} vs ${escape(pick.away_team)}</b>\n`+
  `Pick: <b>${escape(pick.market)}</b>\nOdds: <b>@${Number(pick.implied_odd).toFixed(2)}</b> · ML estimate ${Number(pick.probability).toFixed(1)}%\n`+
  `${escape(engineNames[pick.pick_type])} · Round ${Number(pick.round_number)} · ${escape(time)} WAT\n${status}\n\n<i>One selected signal. Results update this card.</i>`;
}
function eligible(db,config,now,validate=require('./strategy_release').filterValidatedPicks){
 const present=db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_best_picks_history'").get();if(!present)return [];
 // The next fifteen minutes only; never replay old cards or flood all future rounds.
 const rows=db.prepare("SELECT * FROM ai_best_picks_history WHERE status='pending' AND kickoff_timestamp>? AND kickoff_timestamp<=? ORDER BY kickoff_timestamp,id").all(now+60000,now+15*60000)
  .filter(r=>engineNames[r.pick_type]&&r.model_version&&Number.isFinite(Number(r.implied_odd))&&Number(r.implied_odd)>1&&Number(r.probability)>0&&Number(r.probability)<100);
 return validate(rows).sort((a,b)=>Number(b.probability)-Number(a.probability)||a.kickoff_timestamp-b.kickoff_timestamp||a.id-b.id);
}
function claim(db,config,pick,source,now){
 const key=eventKey(config,pick),bot=namespace(config),day=Math.floor((now+3600000)/86400000)*86400000-3600000;
 return db.transaction(()=>{
  if(db.prepare('SELECT 1 FROM telegram_feed_events WHERE event_key=?').get(key))return {claimed:false,reason:'duplicate'};
  const today=db.prepare('SELECT COUNT(*) n FROM telegram_feed_events WHERE bot_key=? AND created_at>=?').get(bot,day).n;
  if(today>=config.dailySignalLimit)return {claimed:false,reason:'daily_limit'};
  const last=db.prepare('SELECT MAX(created_at) last FROM telegram_feed_events WHERE bot_key=?').get(bot).last;
  if(last!=null&&now-last<config.signalGapMinutes*60000)return {claimed:false,reason:'cooldown'};
  db.prepare("INSERT INTO telegram_feed_events VALUES(?,?,?,?,?,?,'sending')").run(key,bot,config.provider,source,JSON.stringify(pick),now);
  for(const target of recipients(config,now))db.prepare("INSERT INTO telegram_feed_deliveries(event_key,target,state) VALUES(?,?,'reserved')").run(key,target);
  return {claimed:true,key};
 }).immediate();
}
async function pending(source,config,options={}){
 const now=options.now??Date.now(),picks=eligible(source,config,now,options.validate);
 if(!picks.length)return {success:true,sentCount:0,reason:'No qualified upcoming signals'};
 if(!config.botToken||!recipients(config,now).length)return {success:false,sentCount:0,error:'No Telegram destinations configured'};
 const store=ledger(options),send=options.send||require('./telegram_transport').send;let sent=0;
 try{
  for(const pick of picks){
   const reserved=claim(store.db,config,pick,sourceName(source),now);
   if(!reserved.claimed){if(reserved.reason==='duplicate')continue;return {success:true,sentCount:0,reason:reserved.reason};}
   for(const row of store.db.prepare('SELECT * FROM telegram_feed_deliveries WHERE event_key=?').all(reserved.key)){
    // A stale inference or a fixture that has started cannot become a late alert.
    const at=options.now??Date.now();
    if(!eligible(source,config,at,options.validate).some(p=>p.id===pick.id&&p.model_version===pick.model_version)){
     store.db.prepare("UPDATE telegram_feed_deliveries SET state='skipped_stale' WHERE id=?").run(row.id);continue;
    }
    store.db.prepare("UPDATE telegram_feed_deliveries SET state='sending' WHERE id=? AND state='reserved'").run(row.id);
    let res;try{res=await send(config.botToken,row.target,render(pick,config));}catch{res={ok:false,uncertain:true};}
    const state=res.ok&&res.result?.message_id?'sent':res.uncertain||res.ok?'uncertain':'failed';
    store.db.prepare('UPDATE telegram_feed_deliveries SET state=?,message_id=? WHERE id=?').run(state,res.result?.message_id||null,row.id);
    sent+=Number(state==='sent');
   }
   store.db.prepare("UPDATE telegram_feed_events SET state=? WHERE event_key=?").run(sent?'sent':'delivery_review',reserved.key);
   return {success:sent>0,sentCount:Number(sent>0),recipientCount:sent,reason:sent?'sent':'Delivery needs review; automatic resend suppressed'};
  }
  return {success:true,sentCount:0,duplicate:true};
 }finally{store.close();}
}
async function settled(source,config,options={}){
 const store=ledger(options),edit=options.edit||require('./telegram_transport').edit,now=options.now??Date.now();let edited=0;
 try{
  const events=store.db.prepare("SELECT * FROM telegram_feed_events WHERE bot_key=? AND provider=? AND source_db=? AND state IN ('sent','delivery_review') ORDER BY created_at DESC LIMIT 100").all(namespace(config),config.provider,sourceName(source));
  for(const event of events){
   const frozen=JSON.parse(event.pick_json),result=source.prepare('SELECT * FROM ai_best_picks_history WHERE id=?').get(frozen.id);
   if(!result||!['won','lost','void'].includes(result.status)||['season_name','round_number','home_team','away_team','market','kickoff_timestamp'].some(k=>result[k]!==frozen[k]))continue;
   if(result.status!=='void'&&!/^\d+:\d+$/.test(result.actual_score||''))continue;
   for(const row of store.db.prepare("SELECT * FROM telegram_feed_deliveries WHERE event_key=? AND state='sent' AND edit_state!='done' AND edit_attempts<3").all(event.event_key)){
    const claimed=store.db.prepare("UPDATE telegram_feed_deliveries SET edit_state='working',edit_at=?,edit_attempts=edit_attempts+1 WHERE id=? AND (edit_state='pending' OR edit_state='error' AND edit_at<? OR edit_state='working' AND edit_at<?)").run(now,row.id,now-5*60000,now-5*60000);
    if(!claimed.changes)continue;
    let res;try{res=await edit(config.botToken,row.target,row.message_id,render(frozen,config,result));}catch{res={ok:false};}
    store.db.prepare('UPDATE telegram_feed_deliveries SET edit_state=? WHERE id=?').run(res.ok?'done':'error',row.id);edited+=Number(!!res.ok);
   }
  }
  return {success:true,sentCount:0,editedCount:edited};
 }finally{store.close();}
}
module.exports={ensure,recipients,eventKey,render,eligible,claim,pending,settled};
