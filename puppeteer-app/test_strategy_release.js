const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {releaseStatus}=require('./utils/strategy_release');
test('2x release requires its own positive funded historical AND forward results',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'strategy-proof-'));
    const file=path.join(directory,'high_chance_strategy_gate.json');
    const good={mode:'martingale_2_0',startingBankroll:100000,baseStake:60,cap:7,n:100,days:5,netProfit:1000,dayClusterProfitLower:200,unableToFundNextStake:false};
    const write=(changes={})=>fs.writeFileSync(file,JSON.stringify({version:'v1',updated_at:new Date().toISOString(),historical:good,forward:good,...changes}));
    try{
        assert.equal(releaseStatus('high_chance','v1',directory).passed,false);
        write();assert.equal(releaseStatus('high_chance','v1',directory).passed,true);
        assert.equal(releaseStatus('high_chance','v2',directory).passed,false);
        for(const bad of [{netProfit:-1},{dayClusterProfitLower:-1},{n:99},{days:4},{unableToFundNextStake:true},{startingBankroll:10000},{baseStake:100},{cap:8},{mode:'martingale_3_0'}]){
            write({forward:{...good,...bad}});assert.equal(releaseStatus('high_chance','v1',directory).passed,false);
            write({historical:{...good,...bad}});assert.equal(releaseStatus('high_chance','v1',directory).passed,false);
        }
        write({updated_at:new Date(Date.now()-7*3600000).toISOString()});assert.equal(releaseStatus('high_chance','v1',directory).passed,false);
    }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});

test('either 2x or 3x can qualify but one mode cannot inherit another mode evidence',()=>{
    const {qualifyStrategies}=require('./utils/strategy_release');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mode-proof-')),file=path.join(directory,'ai_best_strategy_gate.json');
    const good=mode=>({mode,startingBankroll:100000,baseStake:60,cap:7,n:120,days:5,netProfit:2000,dayClusterProfitLower:100,unableToFundNextStake:false});
    const two=good('martingale_2_0'),three=good('martingale_3_0');
    const write=strategies=>fs.writeFileSync(file,JSON.stringify({version:'v1',updated_at:new Date().toISOString(),strategies}));
    try{
        write({martingale_3_0:{historical:three,forward:three}});
        assert.equal(releaseStatus('ai_best','v1',directory).passed,false);
        assert.equal(releaseStatus('ai_best','v1',directory,'martingale_3_0').passed,true);
        assert.deepEqual(releaseStatus('ai_best','v1',directory).qualifiedModes,['martingale_3_0']);
        assert.equal(releaseStatus('ai_best','v2',directory,'martingale_3_0').passed,false);
        // A 2x historical pass plus a 3x forward pass qualifies neither mode.
        const h={martingale_2_0:two},f={martingale_3_0:three};
        assert.ok(Object.values(qualifyStrategies(h,f)).every(r=>!r.passed));
        write({martingale_2_0:{historical:two,forward:two},martingale_3_0:{historical:three,forward:{...three,unableToFundNextStake:true}}});
        assert.equal(releaseStatus('ai_best','v1',directory).passed,true);
        assert.equal(releaseStatus('ai_best','v1',directory,'martingale_3_0').passed,false);
        write({martingale_3_0:{historical:two,forward:two}});
        assert.equal(releaseStatus('ai_best','v1',directory,'martingale_3_0').passed,false);
        write({martingale_2_0:{historical:two,forward:two},martingale_3_0:{historical:three,forward:three}});
        assert.deepEqual(releaseStatus('ai_best','v1',directory).qualifiedModes,['martingale_2_0','martingale_3_0']);
        assert.equal(releaseStatus('ai_best','v1',directory,'fixed').passed,false);
    }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});

test('evidence exposes separate 2x/3x verdicts and retains the individual result',()=>{
    const {attachQualification}=require('./utils/strategy_evidence');
    const good=mode=>({mode,startingBankroll:100000,baseStake:60,cap:7,n:100,days:5,netProfit:500,dayClusterProfitLower:20,unableToFundNextStake:false});
    const two={...good('martingale_2_0'),netProfit:-100},three=good('martingale_3_0');
    const result=attachQualification({historical:{qualified:{martingale_2_0:two,martingale_3_0:three}},forward:{qualified:{martingale_2_0:two,martingale_3_0:three}}});
    assert.equal(result.twoXProfitabilityProven,false);assert.equal(result.threeXProfitabilityProven,true);assert.equal(result.profitabilityProven,true);
    assert.deepEqual(result.qualifiedStakingModes,['martingale_3_0']);
});
test('queued signals must still belong to the ready active version when published',()=>{
    const {filterValidatedPicks}=require('./utils/strategy_release');
    const picks=[{pick_type:'safest',model_version:'v1',match_time:'12:00'},
        {pick_type:'high_value',model_version:'old',match_time:'12:00'},
        {pick_type:'high_value',model_version:'v1',match_time:'00:00'},
        {pick_type:'ai_best_pick',model_version:'v1',match_time:'12:00'},
        {pick_type:'safest',match_time:'12:00'}];
    assert.deepEqual(filterValidatedPicks(picks,engine=>({ready:engine!=='ai_best',version:'v1'})),[picks[0]]);
});
