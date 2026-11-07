const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const fs=require('fs'),os=require('os'),path=require('path'),feed=require('./utils/telegram_curated_feed');
const at=Date.UTC(2026,9,29,1),config={botToken:'test-token',chatId:'main',vipGroupId:'vip',targetChannel:'main',provider:'sportybet',dailySignalLimit:20,signalGapMinutes:30,channelTitle:'Test signals'};
const pick=(i=1,now=at)=>({id:i,season_name:'Sportybet England',round_number:i,home_team:'Home',away_team:'Away',market:'Over 2.5 Goals',pick_type:'safest',model_version:'v1',probability:80,implied_odd:1.8,kickoff_timestamp:now+300000,status:'pending',actual_score:null});
function source(rows=[pick()]){const db=new Database(':memory:');db.exec('CREATE TABLE ai_best_picks_history(id INTEGER PRIMARY KEY,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,market TEXT,pick_type TEXT,model_version TEXT,probability REAL,implied_odd REAL,kickoff_timestamp INTEGER,status TEXT,actual_score TEXT)');
 const insert=db.prepare('INSERT INTO ai_best_picks_history VALUES(@id,@season_name,@round_number,@home_team,@away_team,@market,@pick_type,@model_version,@probability,@implied_odd,@kickoff_timestamp,@status,@actual_score)');for(const r of rows)insert.run(r);return db;}
const store=()=>{const d=new Database(':memory:');feed.ensure(d);return d;},approved=rows=>rows;
test('only qualified, genuinely future, quoted signals are eligible; no replay or paper fallback',()=>{
 const db=source([pick(),{...pick(2),kickoff_timestamp:at-1},{...pick(3),model_version:null},{...pick(4),implied_odd:1},{...pick(5),kickoff_timestamp:at+3600000},{...pick(6),pick_type:'goals'}]);
 assert.deepEqual(feed.eligible(db,config,at,approved).map(r=>r.id),[1]);
 assert.equal(feed.eligible(db,config,at,()=>[]).length,0);db.close();
});
test('routing respects VIP-only and sends once when group and subscriber destinations overlap',()=>{
 const subscribers=[{chatId:'vip',status:'active'},{chatId:'alice',status:'active'},{chatId:'old',status:'active',expiryDate:'2020-01-01'},{chatId:'inactive',status:'inactive'}];
 assert.deepEqual(feed.recipients({...config,targetChannel:'vip',subscribers},at),['vip','alice']);
 assert.deepEqual(feed.recipients({...config,targetChannel:'both',subscribers},at),['main','vip','alice']);
});
test('global WAT-day cap and minimum spacing survive another source or mode',()=>{
 const db=store();for(let i=0;i<20;i++)assert.equal(feed.claim(db,config,pick(i+1,at+i*1800000),'one',at+i*1800000).claimed,true);
 assert.equal(feed.claim(db,config,pick(25,at+20*1800000),'two',at+20*1800000).reason,'daily_limit');
 const tomorrow=at+86400000;assert.equal(feed.claim(db,{...config,provider:'bet9ja'},pick(30,tomorrow),'two',tomorrow).claimed,true);
 assert.equal(feed.claim(db,config,pick(31,tomorrow+1000),'one',tomorrow+1000).reason,'cooldown');db.close();
});
test('concurrent workers reserve a round before network I/O and cannot duplicate another format',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-feed-')),file=path.join(folder,'delivery.db');
 const a=new Database(file),b=new Database(file),db=source();let calls=0,release;
 const send=async()=>{calls++;await new Promise(r=>release=r);return {ok:true,result:{message_id:99}};};
 try{
  const first=feed.pending(db,config,{deliveryDb:a,now:at,validate:approved,send});
  assert.equal(calls,1);
  const second=await feed.pending(db,config,{deliveryDb:b,now:at,validate:approved,send});assert.equal(second.sentCount,0);assert.equal(calls,1);
  release();assert.equal((await first).sentCount,1);
  assert.equal((await feed.pending(db,{...config,broadcastMode:'another'},{deliveryDb:b,now:at,validate:approved,send:async()=>{throw Error('Duplicate send');}})).sentCount,0);
 }finally{db.close();a.close();b.close();fs.rmSync(folder,{recursive:true});}
});
test('ambiguous delivery cannot be retried after timeout or process restart',async()=>{
 const db=source(),delivery=store();let calls=0;
 const send=async()=>{calls++;return {ok:false,uncertain:true};};
 await feed.pending(db,config,{deliveryDb:delivery,now:at,validate:approved,send});
 await feed.pending(db,config,{deliveryDb:delivery,now:at+60000,validate:approved,send});
 assert.equal(calls,1);assert.equal(delivery.prepare('SELECT state FROM telegram_feed_deliveries').get().state,'uncertain');db.close();delivery.close();
});
test('result edits update the sent card once and never send another result alert',async()=>{
 const db=source(),delivery=store();let sends=0,edits=0,lastText='';
 await feed.pending(db,config,{deliveryDb:delivery,now:at,validate:approved,send:async()=>{sends++;return {ok:true,result:{message_id:42}};}});
 db.exec("UPDATE ai_best_picks_history SET status='lost',actual_score='1:0'");
 const edit=async(token,target,id,text)=>{assert.equal(id,42);edits++;lastText=text;return {ok:true};};
 assert.equal((await feed.settled(db,config,{deliveryDb:delivery,now:at+600000,edit})).editedCount,1);
 assert.equal((await feed.settled(db,config,{deliveryDb:delivery,now:at+600001,edit})).editedCount,0);
 assert.equal(sends,1);assert.equal(edits,1);assert.match(lastText,/Lost/);assert.match(lastText,/Score 1:0/);db.close();delivery.close();
});
test('missing results and reused fixture IDs cannot edit a different published card',async()=>{
 const db=source(),delivery=store();let edits=0;
 await feed.pending(db,config,{deliveryDb:delivery,now:at,validate:approved,send:async()=>({ok:true,result:{message_id:1}})});
 const edit=async()=>{edits++;return {ok:true};};
 await feed.settled(db,config,{deliveryDb:delivery,now:at+600000,edit});
 db.exec("UPDATE ai_best_picks_history SET status='won',actual_score='3:0',home_team='Other'");
 await feed.settled(db,config,{deliveryDb:delivery,now:at+600000,edit});assert.equal(edits,0);db.close();delivery.close();
});
test('partial recipient failure cannot resend the successful channel on another scan',async()=>{
 const db=source(),delivery=store();let calls=0;
 const send=async(token,target)=>{calls++;return target==='main'?{ok:true,result:{message_id:10}}:{ok:false,error_code:403};};
 const cfg={...config,targetChannel:'both'};
 assert.equal((await feed.pending(db,cfg,{deliveryDb:delivery,now:at,validate:approved,send})).sentCount,1);
 assert.equal((await feed.pending(db,cfg,{deliveryDb:delivery,now:at+100,validate:approved,send})).sentCount,0);assert.equal(calls,2);db.close();delivery.close();
});
test('compact formatting is short and escapes team/market markup',()=>{
 const text=feed.render({...pick(),home_team:'<b>Home & team</b>'},config);
 assert.ok(text.length<700);assert.match(text,/&lt;b&gt;Home &amp; team&lt;\/b&gt;/);assert.doesNotMatch(text,/Verified|91.3%|Guaranteed/);
});

test('transport never repeats an ambiguous timed-out send',async()=>{
 const {mock}=require('node:test'),{EventEmitter}=require('events');let calls=0;
 const network=mock.method(require('https'),'request',()=>{calls++;const req=new EventEmitter();req.end=()=>setImmediate(()=>req.emit('timeout'));req.destroy=()=>req.emit('error',Error('reset'));return req;});
 try{const result=await require('./utils/telegram_transport').send('test-token','fake-chat','test');assert.equal(result.uncertain,true);assert.equal(calls,1);}finally{network.mock.restore();}
});
test('result transport edits a known message ID and accepts an already-applied edit',async()=>{
 const {mock}=require('node:test'),{EventEmitter}=require('events');let method='',payload;
 const network=mock.method(require('https'),'request',(options,onResponse)=>{
  method=options.path.split('/').at(-1);const req=new EventEmitter();req.end=body=>{payload=JSON.parse(body);setImmediate(()=>{const res=new EventEmitter();onResponse(res);res.emit('data',JSON.stringify({ok:false,error_code:400,description:'Bad Request: message is not modified'}));res.emit('end');});};return req;
 });
 try{const result=await require('./utils/telegram_transport').edit('test-token','fake-chat',42,'result');assert.equal(result.ok,true);assert.equal(method,'editMessageText');assert.equal(payload.message_id,42);}finally{network.mock.restore();}
});

test('server compact policy and master-off cannot be reopened by a stale browser payload',()=>{
 const {mock}=require('node:test'),original=fs.readFileSync;
 const read=mock.method(fs,'readFileSync',function(file,...args){return String(file).endsWith('bot_settings.json')?JSON.stringify({telegramFeedStyle:'curated',autoPostToTelegram:false,telegramDailySignalLimit:20,telegramSignalGapMinutes:30}):original.call(this,file,...args);});
 try{const config=require('./utils/telegram_broadcaster').loadTelegramSettings({telegramFeedStyle:'legacy',autoPostToTelegram:true,telegramDailySignalLimit:1000});
  assert.equal(config.feedStyle,'curated');assert.equal(config.autoPost,false);assert.equal(config.dailySignalLimit,20);assert.equal(config.signalGapMinutes,30);
 }finally{read.mock.restore();}
});
test('legacy results-off wins over confidence-picks-on, without touching Telegram',async()=>{
 const {mock}=require('node:test'),original=fs.readFileSync,db=new Database(':memory:');let calls=0;
 const read=mock.method(fs,'readFileSync',function(file,...args){return String(file).endsWith('bot_settings.json')?JSON.stringify({telegramFeedStyle:'legacy',autoPostToTelegram:true,telegramPickFilter:'all',autoSendConfidencePicks:true,autoSendConfidenceResults:false,autoSendStreakAlerts:false}):original.call(this,file,...args);});
 const network=mock.method(require('https'),'request',()=>{calls++;throw Error('Network forbidden');});
 try{const result=await require('./utils/telegram_broadcaster').broadcastSettledResults(db);assert.equal(result.success,true);assert.equal(result.sentCount,0);assert.equal(calls,0);}finally{read.mock.restore();network.mock.restore();db.close();}
});
