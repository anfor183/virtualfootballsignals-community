'use strict';
/**
 * bet9ja_gismo_direct.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Fast-path data fetcher for Bet9ja Virtual Football League.
 *
 * HOW IT WORKS
 * ────────────
 * 1.  A CDP session is attached to the existing live_companion page.
 * 2.  We listen for any request to vgls-vs001.akamaized.net/vfl/feeds/ that
 *     contains a fixture, result, standings or schedule endpoint fired by the
 *     Angular app when the user (or our menu-click logic) navigates to a league.
 * 3.  Once we have one real URL we derive the base URL + season/tournament ID
 *     and start polling directly via HTTPS (no browser, no DOM clicks).
 * 4.  The caller receives parsed match arrays in the same shape as the existing
 *     DOM-scraper output so nothing else in live_companion.js needs changing.
 *
 * TOURNAMENTS (from config_tree):
 *   Virtual Football English League  TID=91071  UTID=31867
 *   Virtual Football Bundesliga      TID=33924  UTID=1668   (League 3)
 *   Virtual Football League Mode     TID=54879  UTID=14149
 *
 * API URL PATTERN (Sportradar Gismo):
 *   https://vgls-vs001.akamaized.net/vfl/feeds/?/{client}/{locale}/{tz}/gismo/{event}/{id1}/{id2}
 */

const https  = require('https');
const zlib   = require('zlib');

// ─── Constants ────────────────────────────────────────────────────────────────
const GISMO_HOST    = 'vgls-vs001.akamaized.net';
const GISMO_BASE    = '/vfl/feeds/?/bet9javirtuals/en/Europe:Berlin/gismo';
const REFERER       = 'https://st-cdn001.akamaized.net/bet9javirtuals/en/1';
const POLL_INTERVAL = 25000; // ms between automatic polls when direct mode is live

// Known tournament IDs (from config_tree — static, won't change):
const TOURNAMENTS = {
    english:    { tid: 91071, utid: 31867, name: 'Virtual Football English League' },
    bundesliga: { tid: 33924, utid: 1668,  name: 'Virtual Football League 3' },
    leagueMode: { tid: 54879, utid: 14149, name: 'Virtual Football League Mode' },
};

// ─── Low-level HTTP helper ────────────────────────────────────────────────────
function gismoGet(path) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: GISMO_HOST, path, method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
                'Accept': 'application/json, */*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': REFERER,
                'Origin': 'https://st-cdn001.akamaized.net'
            }
        };
        const req = https.request(opts, res => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const enc = res.headers['content-encoding'];
                const dc = enc === 'gzip' ? zlib.gunzip :
                           enc === 'br'   ? zlib.brotliDecompress :
                           enc === 'deflate' ? zlib.inflate : null;
                if (dc) {
                    dc(raw, (e, d) => e ? reject(e) : resolve({ status: res.statusCode, body: d.toString() }));
                } else {
                    resolve({ status: res.statusCode, body: raw.toString() });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('Gismo request timeout')));
        req.end();
    });
}

async function gismoFetch(event, id1, id2 = 0) {
    const path = `${GISMO_BASE}/${event}/${id1}/${id2}`;
    const { body } = await gismoGet(path);
    const parsed = JSON.parse(body);
    const doc = Array.isArray(parsed.doc) ? parsed.doc[0] : parsed;
    if (doc.event === 'exception') {
        const msg = doc.data ? (doc.data.message || JSON.stringify(doc.data).substring(0, 80)) : 'unknown';
        throw new Error(`Gismo exception for ${event}/${id1}/${id2}: ${msg}`);
    }
    return doc;
}

// ─── Gismo data parsers ───────────────────────────────────────────────────────

/**
 * Parse a Gismo "fixtures" doc into upcoming match objects.
 * Shape: { homeTeam, awayTeam, matchDay, kickoffMs, matchTime }
 */
function parseFixtures(doc) {
    const out = [];
    const data = doc.data;
    if (!data) return out;

    const getEuropeBerlinOffset = () => {
        try {
            const d = new Date();
            const tzDate = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
            const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
            return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
        } catch (e) {
            return 120;
        }
    };
    const offsetMinutes = getEuropeBerlinOffset();

    // Gismo fixtures structure: data is an object keyed by date → array of matches
    // OR data is an array of rounds
    const rounds = Array.isArray(data) ? data : Object.values(data);
    for (const round of rounds) {
        const matches = Array.isArray(round) ? round : (round.matches || round.events || [round]);
        for (const m of matches) {
            if (!m || (!m._homeTeamId && !m.homeTeam && !m.participants)) continue;
            const homeTeam = m.homeTeam || m._homeTeam || (m.participants && m.participants[0] && m.participants[0].name) || '';
            const awayTeam = m.awayTeam || m._awayTeam || (m.participants && m.participants[1] && m.participants[1].name) || '';
            if (!homeTeam || !awayTeam) continue;
            
            const rawDt = m._dt || m.matchStart || m.kickoff;
            let kickoffMs = null;
            if (rawDt) {
                const cleanDt = String(rawDt).trim().replace(' ', 'T');
                const isoStr = cleanDt.includes('Z') ? cleanDt : (cleanDt + 'Z');
                const utcTimeMs = Date.parse(isoStr);
                if (!isNaN(utcTimeMs)) {
                    kickoffMs = utcTimeMs - (offsetMinutes * 60 * 1000);
                }
            }
            const matchTime = kickoffMs ? new Date(kickoffMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '';
            const matchDay = m._roundId || m.round || m.matchDay || m._matchId || 0;
            out.push({ homeTeam, awayTeam, matchDay, kickoffMs, matchTime });
        }
    }
    return out;
}

/**
 * Parse a Gismo "results" doc into scored match objects.
 * Shape: { homeTeam, awayTeam, homeScore, awayScore, htHome, htAway, matchDay }
 */
function parseResults(doc) {
    const out = [];
    const data = doc.data;
    if (!data) return out;

    const rounds = Array.isArray(data) ? data : Object.values(data);
    for (const round of rounds) {
        const matches = Array.isArray(round) ? round : (round.matches || round.events || [round]);
        for (const m of matches) {
            if (!m) continue;
            const homeTeam = m.homeTeam || m._homeTeam || (m.participants && m.participants[0] && m.participants[0].name) || '';
            const awayTeam = m.awayTeam || m._awayTeam || (m.participants && m.participants[1] && m.participants[1].name) || '';
            if (!homeTeam || !awayTeam) continue;
            // Look for FT result
            const result = m.result || m.score || m.finalScore || {};
            const homeFT = result.home !== undefined ? result.home :
                           (m._finalScoreHome !== undefined ? m._finalScoreHome : null);
            const awayFT = result.away !== undefined ? result.away :
                           (m._finalScoreAway !== undefined ? m._finalScoreAway : null);
            if (homeFT === null) continue;
            const htResult = m.htResult || m.halftimeScore || {};
            const htHome = htResult.home !== undefined ? htResult.home : (m._htScoreHome || 0);
            const htAway = htResult.away !== undefined ? htResult.away : (m._htScoreAway || 0);
            const matchDay = m._roundId || m.round || m.matchDay || m._matchId || 0;
            out.push({ homeTeam, awayTeam, homeScore: homeFT, awayScore: awayFT, htHome, htAway, matchDay });
        }
    }
    return out;
}

// ─── Season discovery ─────────────────────────────────────────────────────────
/**
 * Discover the current live season ID for a tournament by parsing config_tree.
 * config_tree doesn't return season IDs directly — we intercept from URLs
 * captured in the CDP session. Falls back to brute-force if no intercept yet.
 */
async function discoverSeasonId(utid) {
    // Try config_tournamentseasons with various formats
    const attempts = [
        () => gismoFetch('config_tournamentseasons', utid, 0),
        () => gismoFetch('season_list', utid, 0),
        () => gismoFetch('config_tournament', utid, 0),
    ];
    for (const attempt of attempts) {
        try {
            const doc = await attempt();
            const data = doc.data;
            if (Array.isArray(data) && data.length > 0) {
                // Find the season with the highest ID (most current)
                const sorted = [...data].sort((a, b) => (b._id || 0) - (a._id || 0));
                return String(sorted[0]._id || sorted[0].id || sorted[0]._seasonId);
            }
            if (data && data._id) return String(data._id);
        } catch(e) { /* try next */ }
    }
    return null;
}

// ─── CDP URL interceptor ──────────────────────────────────────────────────────
/**
 * Attach to an existing CDP session and listen for Gismo API calls
 * so we can extract the exact URL parameters the Angular app uses.
 * Returns a cleanup function.
 */
function attachGismoCapture(cdpSession, onCaptured) {
    const capturedPaths = new Set();

    const handler = ({ request }) => {
        const url = request.url;
        if (!url.includes('vgls-vs001.akamaized.net')) return;
        // Parse out the gismo path components
        // e.g. /vfl/feeds/?/bet9javirtuals/en/Europe:Berlin/gismo/fixtures/91071/12345
        const match = url.match(/\/gismo\/([a-z_]+)\/(\d+)\/(\d+)/i);
        if (!match) return;
        const [, event, id1, id2] = match;
        if (['fixtures', 'results', 'standings', 'schedule', 'calendar'].includes(event)) {
            const key = `${event}/${id1}/${id2}`;
            if (!capturedPaths.has(key)) {
                capturedPaths.add(key);
                console.log(`[Bet9ja Direct] 🎯 Captured Gismo URL: ${event}/${id1}/${id2}`);
                onCaptured({ event, id1, id2, url });
            }
        }
    };

    cdpSession.on('Network.requestWillBeSent', ({ request }) => handler({ request }));
    return () => cdpSession.off('Network.requestWillBeSent', handler);
}

// ─── Main class ───────────────────────────────────────────────────────────────
class Bet9jaGismoDirect {
    /**
     * @param {object}   opts
     * @param {string}   opts.tournamentName  - 'english' | 'bundesliga' | 'leagueMode'
     * @param {function} opts.onFixtures      - callback(fixtures[])
     * @param {function} opts.onResults       - callback(results[])
     */
    constructor({ tournamentName = 'english', onFixtures, onResults }) {
        this.tournament = TOURNAMENTS[tournamentName] || TOURNAMENTS.english;
        this.onFixtures = onFixtures || (() => {});
        this.onResults  = onResults  || (() => {});

        this._capturedIds    = null; // { fixturesId1, fixturesId2, resultsId1, resultsId2 }
        this._pollTimer      = null;
        this._active         = false;
        this._cdpCleanup     = null;
    }

    isAlive() { return this._active && this._capturedIds !== null; }

    /**
     * Attach to a CDP session. Waits for the Angular app to fire its first
     * fixture/result API call, then switches to direct HTTP polling mode.
     */
    attachCDP(cdpSession) {
        this._cdpCleanup = attachGismoCapture(cdpSession, ({ event, id1, id2 }) => {
            if (!this._capturedIds) this._capturedIds = {};
            if (event === 'fixtures' && !this._capturedIds.fixturesId1) {
                this._capturedIds.fixturesId1 = id1;
                this._capturedIds.fixturesId2 = id2;
                console.log(`[Bet9ja Direct] 📡 Fixture URL locked: fixtures/${id1}/${id2}`);
            }
            if (event === 'results' && !this._capturedIds.resultsId1) {
                this._capturedIds.resultsId1 = id1;
                this._capturedIds.resultsId2 = id2;
                console.log(`[Bet9ja Direct] 📡 Results URL locked: results/${id1}/${id2}`);
            }
            // Once we have both, start direct polling
            if (this._capturedIds.fixturesId1 && this._capturedIds.resultsId1 && !this._active) {
                this._startPolling();
            }
        });

        // Also try to bootstrap season ID immediately from the API
        discoverSeasonId(this.tournament.utid).then(sid => {
            if (!sid) return;
            if (!this._capturedIds) this._capturedIds = {};
            console.log(`[Bet9ja Direct] 🔍 Discovered season ID: ${sid} for UTID=${this.tournament.utid}`);
            // Warm up: try fixtures with discovered season ID
            if (!this._capturedIds.fixturesId1) {
                this._capturedIds.fixturesId1 = String(this.tournament.utid);
                this._capturedIds.fixturesId2 = sid;
            }
            if (!this._capturedIds.resultsId1) {
                this._capturedIds.resultsId1 = String(this.tournament.utid);
                this._capturedIds.resultsId2 = sid;
            }
            if (!this._active) this._startPolling();
        }).catch(() => {});
    }

    _startPolling() {
        this._active = true;
        console.log('[Bet9ja Direct] ⚡ Switching to direct HTTP polling mode. No more DOM clicks needed.');
        this._poll();
        this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL);
    }

    async _poll() {
        if (!this._capturedIds) return;
        try {
            await this._fetchFixtures();
        } catch(e) { console.warn('[Bet9ja Direct] Fixture fetch error:', e.message); }
        try {
            await this._fetchResults();
        } catch(e) { console.warn('[Bet9ja Direct] Results fetch error:', e.message); }
    }

    async _fetchFixtures() {
        const { fixturesId1, fixturesId2 } = this._capturedIds;
        const doc = await gismoFetch('fixtures', fixturesId1, fixturesId2);
        const fixtures = parseFixtures(doc);
        if (fixtures.length > 0) {
            console.log(`[Bet9ja Direct] 📅 Got ${fixtures.length} upcoming fixtures via Gismo API`);
            this.onFixtures(fixtures);
        }
    }

    async _fetchResults() {
        const { resultsId1, resultsId2 } = this._capturedIds;
        const doc = await gismoFetch('results', resultsId1, resultsId2);
        const results = parseResults(doc);
        if (results.length > 0) {
            console.log(`[Bet9ja Direct] 🏆 Got ${results.length} match results via Gismo API`);
            this.onResults(results);
        }
    }

    /** Manually trigger an immediate refresh (called from the main loop) */
    requestRefresh() {
        if (!this._active || !this._capturedIds) return;
        this._poll();
    }

    destroy() {
        this._active = false;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._cdpCleanup) { try { this._cdpCleanup(); } catch(e) {} this._cdpCleanup = null; }
        this._capturedIds = null;
        console.log('[Bet9ja Direct] 🔌 Gismo direct client destroyed.');
    }
}

module.exports = { Bet9jaGismoDirect, attachGismoCapture, gismoFetch, TOURNAMENTS };
