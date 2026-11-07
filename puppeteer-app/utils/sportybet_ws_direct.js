/**
 * sportybet_ws_direct.js
 * 
 * Fast-path data fetcher for SportyBet Virtual Football.
 * 
 * Strategy:
 *  1. While the Puppeteer page loads sportybet.com/ng/virtual/, attach CDP Network.enable
 *     on the MAIN page session and listen for Network.webSocketCreated + 
 *     Network.webSocketHandshakeResponseReceived to capture the Golden Race WebSocket
 *     URL and the real request headers the browser sent (Cookie, Origin, etc.).
 *  2. Open a direct Node.js `ws` connection to that same URL using the captured headers.
 *  3. Send Golden Race protocol REQUEST messages for:
 *       /eventBlocks/find          → upcoming fixtures for the target league
 *       /eventBlocks/event/result  → recent match scores
 *  4. Parse and return the payloads exactly like the existing CDP child-session path does,
 *     so the rest of the codebase (DB writes, ML predictions) is unchanged.
 * 
 * Usage:
 *   const { captureWsSession, GoldenRaceDirectWS } = require('./sportybet_ws_direct');
 * 
 *   // During page load, start capturing:
 *   await captureWsSession(page, mainCDPSession, (sessionInfo) => {
 *       directWs = new GoldenRaceDirectWS(sessionInfo, targetLeagueId, onUpcoming, onResult);
 *       directWs.connect();
 *   });
 */

'use strict';

const WebSocket = require('ws');

const GOLDEN_RACE_MSG_TIMEOUT = 8000; // ms to wait for a response after sending a request

const SPORTY_WS_URL_PATTERNS = [
    'virtustec.com',
    'golden-race',
    'goldenrace'
];

function isGoldenRaceWsUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (!lower.startsWith('ws://') && !lower.startsWith('wss://')) return false;
    return SPORTY_WS_URL_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Attaches to the main-page CDP session and listens for the WebSocket that the
 * Golden Race iframe opens.  When captured, calls onCaptured({ url, headers }).
 * 
 * @param {import('puppeteer').CDPSession} mainSession - The already-created CDPSession for the page.
 * @param {(sessionInfo: {url: string, headers: Record<string,string>}) => void} onCaptured
 * @returns {() => void} cleanup function
 */
function attachWsCapture(mainSession, onCaptured) {
    let captured = false;
    // Map of requestId → pending handshake info
    const pendingHandshakes = new Map();

    const onCreated = ({ requestId, url, initiator }) => {
        if (captured) return;
        if (!isGoldenRaceWsUrl(url)) return;
        console.log(`[WS Direct] 🎯 Candidate Sportybet WS detected: ${url}`);
        pendingHandshakes.set(requestId, { url });
    };

    const onHandshake = ({ requestId, response }) => {
        if (captured) return;
        const pending = pendingHandshakes.get(requestId);
        if (!pending) return;

        captured = true;
        pendingHandshakes.clear();

        // Build the headers the browser used for the WS handshake
        const headers = {
            'Origin':     'https://www.sportybet.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        };

        // Pull real request headers from the CDP handshake event if available
        if (response && response.requestHeaders) {
            for (const [k, v] of Object.entries(response.requestHeaders)) {
                headers[k] = v;
            }
        } else {
            console.warn('[WS Direct] ⚠️ Handshake response did not expose request headers; using fallback headers.');
        }

        console.log(`[WS Direct] ✅ WS session captured. URL: ${pending.url}`);
        onCaptured({ url: pending.url, headers });
    };

    mainSession.on('Network.webSocketCreated', onCreated);
    mainSession.on('Network.webSocketHandshakeResponseReceived', onHandshake);

    // Return a cleanup function with reset capability
    const cleanup = () => {
        mainSession.off('Network.webSocketCreated', onCreated);
        mainSession.off('Network.webSocketHandshakeResponseReceived', onHandshake);
    };
    cleanup.reset = () => {
        captured = false;
        pendingHandshakes.clear();
    };
    return cleanup;
}

/**
 * Manages a direct WebSocket connection to the Golden Race backend.
 * Automatically sends fixture + result requests and emits parsed data
 * via callbacks.
 */
class GoldenRaceDirectWS {
    /**
     * @param {{ url: string, headers: Record<string,string> }} sessionInfo
     * @param {number} targetLeagueId  e.g. 41104 for England
     * @param {(matches: Array) => void} onUpcomingMatches
     * @param {(results: Array) => void} onResults
     */
    constructor(sessionInfo, targetLeagueId, onUpcomingMatches, onResults, onAuthExpired = null) {
        this.url            = sessionInfo.url;
        this.headers        = sessionInfo.headers;
        this.leagueId       = targetLeagueId;
        this.onUpcoming     = onUpcomingMatches;
        this.onResults      = onResults;
        this.onAuthExpired  = onAuthExpired;
        this.ws             = null;
        this.alive          = false;
        this.reconnecting   = false;
        this._requestId     = 1;
        this._pollTimer     = null;
        this._reconnectTimer= null;
    }

    /** Build a Golden Race REQUEST envelope */
    _buildRequest(resource, params = {}) {
        return JSON.stringify({
            type: 'REQUEST',
            id:   String(this._requestId++),
            req: {
                resource,
                params: {
                    playlistId: this.leagueId,
                    ...params
                }
            }
        });
    }

    /** Parse an incoming WebSocket frame and emit events */
    _handleFrame(rawData) {
        let parsed;
        try {
            const text = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
            if (!text || !text.startsWith('{')) return;
            parsed = JSON.parse(text);
        } catch (e) {
            return;
        }

        if (parsed.type === 'RESPONSE' && parsed.res) {
            if (parsed.res.statusCode === 401 || parsed.res.statusCode === 403) {
                if (typeof this.onAuthExpired === 'function') {
                    this.onAuthExpired();
                }
                return;
            }
        }

        if (parsed.type !== 'RESPONSE' || !parsed.res || parsed.res.statusCode !== 200) return;

        const resource = parsed.res.resource;
        const blocks   = parsed.res.body;
        if (!Array.isArray(blocks)) return;

        if (resource === '/eventBlocks/find' || resource === '/eventBlocks/event/data') {
            const upcomingMatches = [];
            for (const block of blocks) {
                if (!block.events || block.playlistId !== this.leagueId) continue;
                const matchDay = block.data?.matchDay || block.data?.matchday ||
                                 block.data?.weekDay  || block.data?.legOrd   || 0;
                for (const event of block.events) {
                    if (!event.data?.participants || event.data.participants.length < 2) continue;
                    
                    const odds = event.data.oddValues;
                    const parsedOdds = (odds && odds.length >= 58) ? {
                        home: parseFloat(odds[0]) || null,
                        away: parseFloat(odds[1]) || null,
                        draw: parseFloat(odds[2]) || null,
                        x2: parseFloat(odds[12]) || null,
                        dc12: parseFloat(odds[13]) || null,
                        dc1x: parseFloat(odds[14]) || null,
                        ng: (odds.length > 50) ? (parseFloat(odds[50]) || null) : null,
                        gg: (odds.length > 51) ? (parseFloat(odds[51]) || null) : null,
                        under05: (odds.length > 52) ? (parseFloat(odds[52]) || null) : null,
                        over05: (odds.length > 53) ? (parseFloat(odds[53]) || null) : null,
                        under15: (odds.length > 54) ? (parseFloat(odds[54]) || null) : null,
                        over15: (odds.length > 55) ? (parseFloat(odds[55]) || null) : null,
                        under25: (odds.length > 56) ? (parseFloat(odds[56]) || null) : null,
                        over25: (odds.length > 57) ? (parseFloat(odds[57]) || null) : null,
                        under35: (odds.length > 58) ? (parseFloat(odds[58]) || null) : null,
                        over35: (odds.length > 59) ? (parseFloat(odds[59]) || null) : null,
                        under45: (odds.length > 60) ? (parseFloat(odds[60]) || null) : null,
                        over45: (odds.length > 61) ? (parseFloat(odds[61]) || null) : null,
                        htft: {
                            htft11: parseFloat(odds[3]) || null,
                            htft1X: parseFloat(odds[4]) || null,
                            htft12: parseFloat(odds[5]) || null,
                            htftX1: parseFloat(odds[6]) || null,
                            htftXX: parseFloat(odds[7]) || null,
                            htftX2: parseFloat(odds[8]) || null,
                            htft21: parseFloat(odds[9]) || null,
                            htft2X: parseFloat(odds[10]) || null,
                            htft22: parseFloat(odds[11]) || null
                        },
                        raw: odds
                    } : null;

                    upcomingMatches.push({
                        homeTeam:  _fmt(event.data.participants[0].fifaCode, event.data.participants[0].name),
                        awayTeam:  _fmt(event.data.participants[1].fifaCode, event.data.participants[1].name),
                        matchDay,
                        eventTime: block.eventTime,
                        odds: parsedOdds
                    });
                }
            }
            if (upcomingMatches.length > 0) {
                console.log(`[WS Direct] 📅 Received ${upcomingMatches.length} upcoming fixtures via direct WS`);
                this.onUpcoming(upcomingMatches);
            }
        } else if (resource === '/eventBlocks/event/result') {
            const results = [];
            for (const block of blocks) {
                if (!block.events || block.playlistId !== this.leagueId) continue;
                for (const event of block.events) {
                    if (!event.data?.participants || event.data.participants.length < 2) continue;
                    if (!event.result?.finalOutcome) continue;
                    const scores = event.result.finalOutcome;
                    if (!Array.isArray(scores) || scores.length < 4) continue;

                    const odds = event.data?.oddValues;
                    const parsedOdds = (odds && odds.length >= 58) ? {
                        home: parseFloat(odds[0]) || null,
                        away: parseFloat(odds[1]) || null,
                        draw: parseFloat(odds[2]) || null,
                        x2: parseFloat(odds[12]) || null,
                        dc12: parseFloat(odds[13]) || null,
                        dc1x: parseFloat(odds[14]) || null,
                        ng: (odds.length > 50) ? (parseFloat(odds[50]) || null) : null,
                        gg: (odds.length > 51) ? (parseFloat(odds[51]) || null) : null,
                        under05: (odds.length > 52) ? (parseFloat(odds[52]) || null) : null,
                        over05: (odds.length > 53) ? (parseFloat(odds[53]) || null) : null,
                        under15: (odds.length > 54) ? (parseFloat(odds[54]) || null) : null,
                        over15: (odds.length > 55) ? (parseFloat(odds[55]) || null) : null,
                        under25: (odds.length > 56) ? (parseFloat(odds[56]) || null) : null,
                        over25: (odds.length > 57) ? (parseFloat(odds[57]) || null) : null,
                        under35: (odds.length > 58) ? (parseFloat(odds[58]) || null) : null,
                        over35: (odds.length > 59) ? (parseFloat(odds[59]) || null) : null,
                        under45: (odds.length > 60) ? (parseFloat(odds[60]) || null) : null,
                        over45: (odds.length > 61) ? (parseFloat(odds[61]) || null) : null,
                        htft: {
                            htft11: parseFloat(odds[3]) || null,
                            htft1X: parseFloat(odds[4]) || null,
                            htft12: parseFloat(odds[5]) || null,
                            htftX1: parseFloat(odds[6]) || null,
                            htftXX: parseFloat(odds[7]) || null,
                            htftX2: parseFloat(odds[8]) || null,
                            htft21: parseFloat(odds[9]) || null,
                            htft2X: parseFloat(odds[10]) || null,
                            htft22: parseFloat(odds[11]) || null
                        },
                        raw: odds
                    } : null;

                    results.push({
                        homeTeam:  _fmt(event.data.participants[0].fifaCode, event.data.participants[0].name),
                        awayTeam:  _fmt(event.data.participants[1].fifaCode, event.data.participants[1].name),
                        htHome:    parseInt(scores[0], 10),
                        htAway:    parseInt(scores[1], 10),
                        homeScore: parseInt(scores[0], 10) + parseInt(scores[2], 10),
                        awayScore: parseInt(scores[1], 10) + parseInt(scores[3], 10),
                        eventTime: block.eventTime,
                        odds: parsedOdds
                    });
                }
            }
            if (results.length > 0) {
                console.log(`[WS Direct] 🏆 Received ${results.length} match results via direct WS`);
                this.onResults(results);
            }
        }
    }

    /** Open the direct WebSocket connection */
    connect() {
        if (this.ws) {
            try { this.ws.terminate(); } catch(e) {}
        }

        // Sanitize headers to remove WebSocket negotiation headers which are managed internally by the ws library
        const cleanHeaders = { ...this.headers };
        const wsInternalHeaders = [
            'sec-websocket-key',
            'sec-websocket-version',
            'sec-websocket-extensions',
            'sec-websocket-accept',
            'sec-websocket-protocol',
            'upgrade',
            'connection'
        ];
        for (const key of Object.keys(cleanHeaders)) {
            if (wsInternalHeaders.includes(key.toLowerCase())) {
                delete cleanHeaders[key];
            }
        }

        console.log(`[WS Direct] 🔌 Connecting to Golden Race WS...`);
        this.ws = new WebSocket(this.url, {
            headers: cleanHeaders,
            handshakeTimeout: 10000,
            perMessageDeflate: false
        });

        this.ws.on('open', () => {
            console.log('[WS Direct] ✅ Direct WS connected to Golden Race!');
            this.alive = true;
            this.reconnecting = false;

            // Immediately request current upcoming fixtures
            this._sendRequest('/eventBlocks/find');
            // And request recent results
            this._sendRequest('/eventBlocks/event/result');

            // Start periodic polling (every 25s to stay ahead of the 30s click loop)
            this._startPolling();
        });

        this.ws.on('message', (data) => {
            this._handleFrame(data);
        });

        this.ws.on('ping', () => {
            try { this.ws.pong(); } catch(e) {}
        });

        this.ws.on('close', (code, reason) => {
            this.alive = false;
            console.log(`[WS Direct] ⚠️ Direct WS closed (code=${code}). Will reconnect in 15s...`);
            this._clearPolling();
            this._scheduleReconnect(15000);
        });

        this.ws.on('error', (err) => {
            this.alive = false;
            console.error(`[WS Direct] ❌ WS error: ${err.message}`);
        });
    }

    /** Send a request message over the direct WS connection */
    _sendRequest(resource, params = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try {
            const msg = this._buildRequest(resource, params);
            this.ws.send(msg);
            console.log(`[WS Direct] → Sent REQUEST ${resource}`);
        } catch (e) {
            console.error(`[WS Direct] Failed to send ${resource}:`, e.message);
        }
    }

    /** Poll for fresh data every 25 seconds */
    _startPolling() {
        this._clearPolling();
        this._pollTimer = setInterval(() => {
            if (!this.alive) return;
            console.log('[WS Direct] 🔄 Polling: requesting fresh fixtures + results...');
            this._sendRequest('/eventBlocks/find');
            // Stagger results request by 2s to avoid overwhelming the server
            setTimeout(() => this._sendRequest('/eventBlocks/event/result'), 2000);
        }, 25000);
    }

    _clearPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _scheduleReconnect(ms) {
        if (this._reconnectTimer || this.reconnecting) return;
        this.reconnecting = true;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.reconnecting = false;
            if (!this.alive) {
                console.log('[WS Direct] 🔄 Attempting reconnect...');
                this.connect();
            }
        }, ms);
    }

    /** Immediately request results (called from the main loop when a match seems scored) */
    requestResults() {
        this._sendRequest('/eventBlocks/event/result');
    }

    /** Immediately request upcoming fixtures */
    requestFixtures() {
        this._sendRequest('/eventBlocks/find');
    }

    /** Check if the direct WS is live and usable */
    isAlive() {
        return this.alive && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /** Close the connection cleanly */
    destroy() {
        this._clearPolling();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.terminate(); } catch(e) {}
            this.ws = null;
        }
        this.alive = false;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TEAM_MAP = {
    'ARS': 'Arsenal',    'AST': 'Aston Villa',  'BOU': 'Bournemouth',
    'BHA': 'Brighton',   'BRN': 'Brentford',    'BUR': 'Burnley',
    'CHE': 'Chelsea',    'CRY': 'Crystal Palace','EVE': 'Everton',
    'FUL': 'Fulham',     'LEE': 'Leeds',         'LIV': 'Liverpool',
    'MCI': 'Manchester City', 'MUN': 'Manchester United', 'NEW': 'Newcastle',
    'FOR': 'Nottm Forest','SUN': 'Sunderland',   'TOT': 'Tottenham',
    'WOL': 'Wolves',     'WHU': 'West Ham'
};

function _fmt(fifaCode, rawName) {
    if (fifaCode && TEAM_MAP[fifaCode]) return TEAM_MAP[fifaCode];
    if (rawName) return rawName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return fifaCode || '';
}

module.exports = { attachWsCapture, GoldenRaceDirectWS };
