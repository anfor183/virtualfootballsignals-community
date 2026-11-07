const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { kickoffHour, pickDecision, withPickPolicy, filterPublishablePicks } = require('./utils/pick_policy');
const fixture = time => ({ kickoff_timestamp: Date.parse(`2030-01-02T${time}+01:00`), match_time: '12:30' });

test('Lagos midnight boundaries override conflicting display times and the host timezone', () => {
    for (const [time, allowed, hour] of [['23:59:59', true, 23], ['00:00:00', false, 0], ['08:59:59', false, 8], ['09:00:00', true, 9]]) {
        const row = fixture(time);
        assert.equal(kickoffHour(row), hour);
        for (const type of ['ai_best', 'ai_best_pick', 'high_value']) assert.equal(pickDecision(type, row).allowed, allowed, `${type} at ${time}`);
        assert.equal(pickDecision('safest', row).allowed, true);
    }
    assert.equal(pickDecision('ai_best', { kickoff_timestamp: Date.parse('2030-01-01T23:00:00Z') }).code, 'midnight_pause');
});

test('legacy WAT time works; missing, invalid and corrupt kickoff times block risky recommendations', () => {
    assert.equal(pickDecision('high_value', { match_time: '08:59' }).allowed, false);
    assert.equal(pickDecision('high_value', { match_time: '09:00' }).allowed, true);
    for (const row of [{}, { match_time: '24:00' }, { match_time: '09:60' }, { kickoff_timestamp: 'garbage', match_time: '12:00' }]) {
        assert.equal(pickDecision('ai_best_pick', row).code, 'unknown_kickoff');
        assert.equal(pickDecision('safest', row).allowed, true);
    }
});

test('stored metadata cannot bypass publishing; Safest and daytime picks remain eligible', () => {
    const night = fixture('00:30:00'), day = fixture('09:00:00');
    const picks = [
        { ...night, pick_type: 'high_value', pickPolicy: { high_value: { allowed: true } } },
        { ...night, pick_type: 'ai_best_pick' },
        { ...night, pick_type: 'safest' },
        { ...day, pick_type: 'high_value' }
    ];
    assert.deepEqual(filterPublishablePicks(picks), picks.slice(2));
    assert.equal(withPickPolicy(night).pickPolicy.high_value.code, 'midnight_pause');
});

test('display preserves probability precision internally and formats valid percentages to one decimal', async () => {
    const { formatProbability } = await import('./utils/pick_display.mjs');
    assert.equal(formatProbability(88.17810149174345), '88.2%');
    assert.equal(formatProbability(32), '32%');
    assert.equal(formatProbability(0), '0%');
    assert.equal(formatProbability(100), '100%');
    for (const value of [null, undefined, '', NaN, Infinity, -1, 101]) assert.equal(formatProbability(value), '—');
});

test('round cards obey the selected round policy and fail closed without server metadata', async () => {
    const { roundPickPolicy, pickPolicyLabel } = await import('./utils/pick_display.mjs');
    const night = withPickPolicy(fixture('08:59:59')), day = withPickPolicy(fixture('09:00:00'));
    assert.equal(roundPickPolicy([night], [day]).high_value.allowed, false);
    assert.equal(roundPickPolicy([day], [night]).high_value.allowed, true);
    assert.equal(roundPickPolicy([night, day]).ai_best_pick.allowed, false);
    assert.equal(roundPickPolicy([{}]).high_value.allowed, false);
    assert.equal(roundPickPolicy([]).high_value.allowed, false);
    assert.match(pickPolicyLabel(roundPickPolicy([night]).high_value), /09:00 WAT/);
    assert.match(pickPolicyLabel(roundPickPolicy([day]).high_value), /Disciplined No-Bet/);
});

test('bundled and single Telegram modes cannot send overnight risky picks, even when forced', async () => {
    const Database = require('better-sqlite3');
    const broadcaster = require('./utils/telegram_broadcaster');
    let networkCalls = 0;
    const blockedRequest = mock.method(require('https'), 'request', () => {
        networkCalls++;
        throw new Error('Network forbidden in policy regression test');
    });
    const db = new Database(':memory:');
    try {
        db.exec(`CREATE TABLE live_predictions (season_name TEXT, round_number INTEGER, home_team TEXT, away_team TEXT,
            kickoff_timestamp INTEGER, match_time TEXT, scored_status INTEGER);
            CREATE TABLE ai_best_picks_history (id INTEGER PRIMARY KEY, season_name TEXT, round_number INTEGER,
            pick_type TEXT, home_team TEXT, away_team TEXT, kickoff_timestamp INTEGER, match_time TEXT, status TEXT);
            INSERT INTO live_predictions VALUES ('Sportybet test',1,'A','B',${fixture('08:59:59').kickoff_timestamp},'08:59',0);
            INSERT INTO ai_best_picks_history VALUES (1,'Sportybet test',1,'high_value','A','B',NULL,NULL,'pending');
            INSERT INTO ai_best_picks_history VALUES (2,'Sportybet test',1,'ai_best_pick','A','B',NULL,NULL,'pending');`);
        for (const telegramPickFilter of ['ai_all', 'high_value', 'ai_only']) {
            const result = await broadcaster.broadcastPendingPredictions(db, {
                telegramPickFilter, autoSendConfidencePicks: false, autoPostToTelegram: true,
                telegramBotToken: 'test-token', telegramChatId: 'test-chat'
            }, true);
            assert.equal(result.success, true, result.error);
            assert.equal(result.sentCount, 0);
        }
        assert.equal(networkCalls, 0);
    } finally {
        blockedRequest.mock.restore();
        db.close();
    }
});
