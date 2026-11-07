import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextSystemStats} from './utils/system_stats.mjs';
const valid = () => ({system:{freeMem:100, totalMem:200, freeDisk:300, totalDisk:400, cpuCores:2}, bots:{ram:0,disk:0,count:0}});
test('failed or incomplete bridge polls preserve the last complete system sample', () => {
    const previous=valid();
    for (const payload of [undefined,null,{}, {error:'service unavailable'}, {system:{}}, {system:valid().system}, {...valid(),bots:null}]) {
        assert.equal(nextSystemStats(previous,payload),previous);
        assert.equal(nextSystemStats(null,payload),null);
    }
    const next=valid();next.system.freeMem=75;
    assert.equal(nextSystemStats(previous,next),next);
});
test('malformed metrics cannot replace a complete sample or trigger false resource alarms', () => {
    const previous=valid();
    for (const value of [undefined,null,'100',NaN,Infinity,-1]) {
        const incoming=valid();incoming.system.freeMem=value;
        assert.equal(nextSystemStats(previous,incoming),previous);
    }
    const noDisk=valid();noDisk.system.freeDisk=0;noDisk.system.totalDisk=0;
    assert.equal(nextSystemStats(previous,noDisk),noDisk);
});
