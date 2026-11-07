'use strict';

// Use the fixture kickoff in Lagos, regardless of the host/browser timezone.
// Experimental paper observations may continue; they are never permission to publish.
const TIMEZONE = 'Africa/Lagos';
const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' });
const RESTRICTED = new Set(['high_value', 'high_chance', 'ai_best', 'ai_best_pick']);

function kickoffHour(match = {}) {
    const raw = match.kickoff_timestamp ?? match.kickoffMs;
    if (raw !== null && raw !== undefined && raw !== '') {
        const epoch = Number(raw);
        if (!Number.isFinite(epoch) || epoch <= 0) return null;
        const date = new Date(epoch);
        return Number.isFinite(date.getTime()) ? Number(hourFormatter.format(date)) : null;
    }
    // Legacy fixtures store match_time explicitly in WAT.
    const time = String(match.match_time || match.matchTime || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    return time && Number(time[1]) < 24 && Number(time[2]) < 60 ? Number(time[1]) : null;
}

function pickDecision(type, match) {
    const hour = kickoffHour(match);
    return {
        allowed: true,
        code: 'allowed',
        hour,
        timezone: TIMEZONE,
        window: 'all_day',
        resumeAt: null
    };
}

function withPickPolicy(match) {
    return { ...match, pickPolicy: Object.fromEntries(['safest', 'high_value', 'ai_best_pick'].map(type => [type, pickDecision(type, match)])) };
}

// Always recompute for broadcasts; stored/caller-supplied metadata cannot override policy.
function filterPublishablePicks(picks) {
    return picks.filter(pick => pickDecision(pick.pick_type, pick).allowed);
}

module.exports = { kickoffHour, pickDecision, withPickPolicy, filterPublishablePicks };
