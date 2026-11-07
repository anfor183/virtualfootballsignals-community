const {test}=require('node:test');
const assert=require('node:assert/strict');
test('new-period summaries and streaks cannot inherit the archived 37-pick AI record',async()=>{
    const {scopeAnalytics}=await import('./utils/analytics_scope.mjs');
    const old=Array.from({length:37},(_,i)=>({id:i+1,pick_type:'ai_best_pick',status:i<5?'won':'lost',market:'A',implied_odd:5.77,probability:24.5,kickoff_timestamp:i}));
    const report={publicationRows:old,settledPicks:old,aiPickSummary:{totalPicks:37,winRate:13.5},
        paperTracking:{trackingRun:{started_at:100,published_after_id:37},newSystem:{settledPicks:[],pendingRows:[]}}};
    const empty=scopeAnalytics(report);assert.equal(empty.aiPickSummary.totalPicks,0);
    assert.equal(empty.aiPickSummary.maxConsecutiveLosses,0);assert.equal(empty.overallPickSummary.totalPicks,0);
    assert.deepEqual(empty.markets,{});assert.equal(report.aiPickSummary.totalPicks,37);
    assert.equal(scopeAnalytics(report,'published').aiPickSummary.totalPicks,37);
    assert.equal(scopeAnalytics(report,'new_published').aiPickSummary.totalPicks,0);
});
test('live performance cards default to new published history while Archive preserves all rows',async()=>{
    const {scopePublishedHistory}=await import('./utils/analytics_scope.mjs');
    const data={trackingRun:{published_after_id:208},aiPicksHistory:[{id:1},{id:208},{id:209}]};
    assert.deepEqual(scopePublishedHistory(data).aiPicksHistory,[{id:209}]);
    assert.equal(scopePublishedHistory(data,'published'),data);
    assert.deepEqual(scopePublishedHistory({...data,trackingRun:null}).aiPicksHistory,[]);
});
test('new pending, win-rate, market and losing-streak cards use the same captured cohort',async()=>{
    const {scopeAnalytics}=await import('./utils/analytics_scope.mjs');
    const rows=['lost','lost','won','pending'].map((status,i)=>({id:-i-1,pick_type:'ai_best_pick',status,market:'Home Win',implied_odd:4,probability:40,kickoff_timestamp:i+100}));
    const report={paperTracking:{newSystem:{settledPicks:rows.slice(0,3),pendingRows:rows.slice(3)}}};
    const view=scopeAnalytics(report);
    assert.equal(view.aiPickSummary.totalPicks,4);assert.equal(view.aiPickSummary.highOddsPending,1);
    assert.equal(view.aiPickSummary.winRate,33.3);assert.equal(view.aiPickSummary.maxConsecutiveLosses,2);
    assert.equal(view.overallPickSummary.totalPicks,4);assert.equal(view.markets['Home Win'].total,4);
    assert.equal(view.stakeUnitsSummary.overall.played,3);
});
