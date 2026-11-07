const { test } = require('node:test');
const assert = require('node:assert/strict');

test('all Martingale multipliers reset after seven losing bets, then repeat', async () => {
    const { martingaleStake, MARTINGALE_CYCLE_CAP } = await import('./utils/staking_cycle.mjs');
    assert.equal(MARTINGALE_CYCLE_CAP, 7);
    for (const multiplier of [1.5, 2, 3]) {
        for (let losses=0; losses<21; losses++) {
            assert.equal(martingaleStake(100, multiplier, losses), 100 * multiplier ** (losses % 7));
        }
        assert.equal(martingaleStake(100, multiplier, 7), 100);
        assert.equal(martingaleStake(100, multiplier, 0), 100); // win resets loss count
    }
});
