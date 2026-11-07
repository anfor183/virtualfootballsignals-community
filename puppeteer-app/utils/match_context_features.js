'use strict';

// Reconstruct context from strictly earlier completed fixtures. This is not a
// claim that a later bookmaker table existed before an archived kickoff.
const NAMES = [
    'h2h_count','h2h_home_win','h2h_draw','h2h_home_goals','h2h_away_goals','h2h_over25','h2h_btts',
    ...['home','away'].flatMap(t=>['form_count','form_points','form_win','form_draw','form_gf','form_ga'].map(k=>`${t}_${k}`)),
    'table_complete','home_rank','away_rank','rank_gap','home_points_per_game','away_points_per_game',
    'home_goal_difference','away_goal_difference','home_played','away_played'
];
function league(row){return String(row.season_name||'').replace(/\s*-?\s*(Week|Round)\s+\d+.*$/i,'').trim().toLowerCase();}
function goals(row){return /^\d+:\d+$/.test(row.actual_score||'')?row.actual_score.split(':').map(Number):null;}
function freshTeam(){return {played:0,points:0,gf:0,ga:0,form:[]};}
const neutral=()=>[0,.5,.33,0,0,.5,.5, 0,.5,.5,.33,0,0, 0,.5,.5,.33,0,0, 0,.5,.5,0,.5,.5,0,0,0,0];

class MatchContext {
    constructor(){this.leagues=new Map();}
    state(key){if(!this.leagues.has(key))this.leagues.set(key,{teams:new Map(),meetings:new Map(),lastRound:0,lastTime:0,start:null,complete:false});return this.leagues.get(key);}
    features(row){
        const state=this.state(league(row)), cutoff=Number(row.kickoff_timestamp),round=Number(row.round_number);
        if(!cutoff || cutoff<=state.lastTime)return neutral();
        const meetings=state.meetings.get([row.home_team,row.away_team].sort().join('|'))||[];
        const oriented=meetings.map(m=>m.home===row.home_team?[m.h,m.a]:[m.a,m.h]);
        const mean=(fn,fallback)=>oriented.length?oriented.reduce((s,m)=>s+fn(m),0)/oriented.length:fallback;
        const result=[oriented.length/5,mean(([h,a])=>Number(h>a),.5),mean(([h,a])=>Number(h===a),.33),
            mean(([h])=>h/5,0),mean(([,a])=>a/5,0),mean(([h,a])=>Number(h+a>2),.5),mean(([h,a])=>Number(h>0&&a>0),.5)];
        const sameSeason=state.start!==null && Math.abs(cutoff-(round-1)*180000-state.start)<=60000 && round>state.lastRound;
        const home=sameSeason?state.teams.get(row.home_team):null,away=sameSeason?state.teams.get(row.away_team):null;
        for(const team of [home,away]){
            const form=team?.form||[],n=form.length,avg=(fn,fallback)=>n?form.reduce((s,m)=>s+fn(m),0)/n:fallback;
            result.push(n/5,avg(m=>m.points/3,.5),avg(m=>Number(m.points===3),.5),avg(m=>Number(m.points===1),.33),
                avg(m=>m.gf/5,0),avg(m=>m.ga/5,0));
        }
        // A partial archive must not pretend to be the full league table.
        const teams=[...state.teams.entries()];
        const complete=sameSeason&&home&&away&&state.complete&&teams.length===20&&teams.every(([,t])=>t.played===round-1);
        if(!complete)result.push(0,.5,.5,0,.5,.5,0,0,0,0);
        else{
            const ranking=teams.sort((a,b)=>b[1].points-a[1].points||(b[1].gf-b[1].ga)-(a[1].gf-a[1].ga)||b[1].gf-a[1].gf||a[0].localeCompare(b[0]));
            const hr=ranking.findIndex(([name])=>name===row.home_team)/19,ar=ranking.findIndex(([name])=>name===row.away_team)/19;
            result.push(1,hr,ar,ar-hr,home.points/(3*home.played),away.points/(3*away.played),
                (home.gf-home.ga)/(5*home.played),(away.gf-away.ga)/(5*away.played),home.played/38,away.played/38);
        }
        return result;
    }
    ingestBatch(rows){
        const groups=new Map();
        for(const row of rows){if(!goals(row)||!Number(row.kickoff_timestamp)||!Number(row.round_number))continue;
            const key=league(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
        for(const [key,batch]of groups){
            const state=this.state(key),time=Number(batch[0].kickoff_timestamp),round=Number(batch[0].round_number);
            if(time<=state.lastTime)continue;
            const start=time-(round-1)*180000;
            if(state.start===null||round<=state.lastRound||Math.abs(start-state.start)>60000){state.teams=new Map();state.complete=round===1;state.start=start;}
            else if(round!==state.lastRound+1)state.complete=false;
            const participants=new Set();
            for(const row of batch){
                if(Number(row.round_number)!==round||Number(row.kickoff_timestamp)!==time){state.complete=false;continue;}
                if(participants.has(row.home_team)||participants.has(row.away_team)){state.complete=false;continue;}
                participants.add(row.home_team);participants.add(row.away_team);
                const [h,a]=goals(row),meetingKey=[row.home_team,row.away_team].sort().join('|');
                const meetings=state.meetings.get(meetingKey)||[];meetings.push({home:row.home_team,h,a});state.meetings.set(meetingKey,meetings.slice(-5));
                for(const [name,gf,ga]of [[row.home_team,h,a],[row.away_team,a,h]]){
                    const team=state.teams.get(name)||freshTeam(),points=gf>ga?3:gf===ga?1:0;
                    team.played++;team.points+=points;team.gf+=gf;team.ga+=ga;team.form.push({gf,ga,points});team.form=team.form.slice(-5);state.teams.set(name,team);
                }
            }
            if(participants.size!==20)state.complete=false;
            state.lastRound=round;state.lastTime=time;
        }
    }
    static fromHistory(rows,before=Infinity){
        const state=new MatchContext(),batches=new Map(),seen=new Set();
        const ordered=[...rows].filter(r=>Number(r.kickoff_timestamp)<before).sort((a,b)=>a.kickoff_timestamp-b.kickoff_timestamp||a.id-b.id);
        for(const row of ordered){const time=Number(row.kickoff_timestamp),key=[league(row),time,row.home_team,row.away_team].join('|');
            if(seen.has(key))continue;seen.add(key);if(!batches.has(time))batches.set(time,[]);batches.get(time).push(row);}
        for(const batch of batches.values())state.ingestBatch(batch);
        return state;
    }
}
module.exports={MatchContext,NAMES};
