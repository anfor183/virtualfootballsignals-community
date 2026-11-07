const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {lookup}=require('./utils/observation_results');
const pick={kickoff_timestamp:1000,season_name:'Sportybet England - Week 1',round_number:1,home_team:'Home',away_team:'Away',market:'1X'};
function db(){const db=new Database(':memory:');for(const table of ['live_predictions','historical_market_predictions'])db.exec(`CREATE TABLE ${table}(kickoff_timestamp INTEGER,season_name TEXT,round_number INTEGER,home_team TEXT,away_team TEXT,actual_score TEXT,actual_ht_score TEXT)`);return db;}
function insert(db,table,extra={}){db.prepare(`INSERT INTO ${table} VALUES(@kickoff_timestamp,@season_name,@round_number,@home_team,@away_team,@actual_score,@actual_ht_score)`).run({...pick,actual_score:'2:0',actual_ht_score:null,...extra});}
test('archived exact results settle observations after the live fixture has been removed',()=>{
 const d=db();insert(d,'historical_market_predictions',{actual_score:'0:3',actual_ht_score:'0:1'});
 assert.deepEqual(lookup(d)(pick),{actual_score:'0:3',actual_ht_score:'0:1'});d.close();
});
test('repeated pairings and nearby kickoffs cannot be substituted',()=>{
 const d=db();insert(d,'historical_market_predictions',{kickoff_timestamp:1001});insert(d,'live_predictions',{season_name:'Sportybet England - Week 2'});
 assert.equal(lookup(d)(pick),null);d.close();
});
test('conflicting scores and missing halftime outcomes fail closed',()=>{
 const d=db();insert(d,'historical_market_predictions');assert.equal(lookup(d)({...pick,market:'HT/FT 1/1'}),null);
 insert(d,'live_predictions',{actual_score:'0:3'});assert.equal(lookup(d)(pick),null);d.close();
});
