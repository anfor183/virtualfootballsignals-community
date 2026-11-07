const settled = p => p.status === 'won' || p.status === 'lost';
export function scopePublishedHistory(data, source='new_system') {
    if (!data || !source.startsWith('new_')) return data;
    const after=data.trackingRun?.published_after_id ?? Infinity;
    return {...data,aiPicksHistory:(data.aiPicksHistory||[]).filter(p=>p.id>after)};
}
export function scopeAnalytics(report, source = 'new_system', minOdds = 3.3) {
    if (!report) return null;
    const paper = report.paperTracking || {}, run = paper.trackingRun;
    const publications = report.publicationRows || report.settledPicks || [];
    let rows;
    if (source === 'new_system') rows = [...(paper.newSystem?.settledPicks || []), ...(paper.newSystem?.pendingRows || [])].filter(p=>!['market_specialist','over35','under35'].includes(p.pick_type));
    else if (source === 'new_published') rows = run ? publications.filter(p => p.id > run.published_after_id) : [];
    else if (source === 'paper') rows = [...(paper.settledPicks || []), ...(paper.pendingRows || [])];
    else rows = publications;
    rows = [...rows].sort((a,b) => Number(a.kickoff_timestamp)-Number(b.kickoff_timestamp) || (a.id||0)-(b.id||0));
    const summary = values => {
        const completed=values.filter(settled), won=completed.filter(p=>p.status==='won').length;
        let streak=0,max=0;
        for(const p of completed){streak=p.status==='lost'?streak+1:0;max=Math.max(max,streak);}
        const odds=values.map(p=>Number(p.implied_odd)).filter(n=>Number.isFinite(n)&&n>1);
        const probs=values.map(p=>Number(p.probability)).filter(n=>Number.isFinite(n)&&n>=0&&n<=100);
        return {totalPicks:values.length,pendingPicks:values.filter(p=>p.status==='pending').length,settledPicks:completed.length,
            highOddsPending:values.filter(p=>p.status==='pending'&&Number(p.implied_odd)>=minOdds).length,
            avgImpliedOdd:odds.length?Number((odds.reduce((a,b)=>a+b,0)/odds.length).toFixed(2)):0,
            avgProbability:probs.length?Number((probs.reduce((a,b)=>a+b,0)/probs.length).toFixed(1)):0,
            winRate:completed.length?Number((won/completed.length*100).toFixed(1)):0,
            maxConsecutiveLosses:max,maxConsecutiveLossesHighOdds:max,highOddsSettledPicks:completed.length};
    };
    const markets={};
    for(const p of rows){if(!p.market)continue;const m=markets[p.market]||{total:0,odds_3_3_plus:0,percentage:0,confidence:0,won:0,lost:0};
        m.total++;m.odds_3_3_plus+=Number(Number(p.implied_odd)>=minOdds);m.won+=Number(p.status==='won');m.lost+=Number(p.status==='lost');
        m.percentage=Number((m.odds_3_3_plus/m.total*100).toFixed(1));m.confidence=Math.min(100,m.total/30*100);
        m.winRate=m.won+m.lost?Number((m.won/(m.won+m.lost)*100).toFixed(1)):null;markets[p.market]=m;}
    const stakeUnitsSummary=Object.fromEntries(['overall','safest','high_value','ai_best_pick','goals','over35','under35','market_specialist'].map(type=>{
        const picks=rows.filter(p=>settled(p)&&Number.isFinite(Number(p.implied_odd))&&Number(p.implied_odd)>1&&(type==='overall'||p.pick_type===type));
        const won=picks.filter(p=>p.status==='won').length;
        const profit=picks.reduce((s,p)=>s+(p.status==='won'?Number(p.implied_odd)-1:-1),0)*100;
        return [type,{played:picks.length,won,lost:picks.length-won,void:0,profit,winRate:picks.length?won/picks.length*100:0,roi:picks.length?profit/picks.length:0}];
    }));
    return {...report,markets,stakeUnitsSummary,settledPicks:rows.filter(settled),
        aiPickSummary:summary(rows.filter(p=>p.pick_type==='ai_best_pick')),overallPickSummary:summary(rows),
        topAIPredictions:rows.filter(p=>p.pick_type==='ai_best_pick'&&p.status==='pending'&&Number(p.implied_odd)>=minOdds)
            .sort((a,b)=>b.implied_odd-a.implied_odd).slice(0,5),trackingScope:source};
}
