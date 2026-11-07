// Force desktop device argument before loading configuration
if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}

const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config');
const mlPredictor = require('./ml_predictor');
const { predictFromRows, optimizeBlendingWeights } = mlPredictor;
const { updateAIPicksHistory, settlePendingAIPicks, evaluatePickOutcome } = require('./live_companion');
const oddsAnalyzer = require('./odds_analyzer');
const { getTimeAdjustmentFactor } = require('./time_pattern_analyzer');
const { attachWsCapture, GoldenRaceDirectWS } = require('./sportybet_ws_direct');
const { logger, settlementLogger, scraperLogger } = require('./robust_logger');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const SPORTY_IFRAME_SELECTOR = 'iframe[src*="virtustec.com"], iframe[src*="golden-race"], iframe[src*="goldenrace"], iframe[src*="sportybet.com"], iframe[src*="virtual"]';
const SPORTY_IFRAME_PATTERNS = ['virtustec.com', 'golden-race', 'goldenrace', 'sportybet.com', 'virtual'];

function isSportyIframeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return SPORTY_IFRAME_PATTERNS.some(pattern => lower.includes(pattern));
}

function findSportyIframe(frames) {
    if (!Array.isArray(frames)) return null;
    return frames.find(frame => frame.parentFrame() !== null && isSportyIframeUrl(frame.url()));
}

async function resolveSportyIframe(page) {
    if (!page) return null;
    try {
        // 1. Try page.frames()
        const frames = typeof page.frames === 'function' ? page.frames() : [];
        let frame = frames.find(f => {
            try { return f !== page.mainFrame() && isSportyIframeUrl(f.url()); } catch (_) { return false; }
        });
        if (frame && !frame.isDetached()) return frame;

        // 2. Try page.mainFrame().childFrames()
        try {
            const childFrames = page.mainFrame ? page.mainFrame().childFrames() : [];
            frame = childFrames.find(f => isSportyIframeUrl(f.url()));
            if (frame && !frame.isDetached()) return frame;
        } catch (_) {}

        // 3. Query iframe DOM elements and retrieve contentFrame (handles OOPIFs)
        let iframeEls = await page.$$(SPORTY_IFRAME_SELECTOR);
        if (!iframeEls || iframeEls.length === 0) {
            iframeEls = await page.$$('iframe');
        }
        for (const el of iframeEls) {
            try {
                const cf = await el.contentFrame();
                if (cf && !cf.isDetached() && isSportyIframeUrl(cf.url())) {
                    return cf;
                }
            } catch (_) {}
        }
    } catch (_) {}

    return null;
}


const TEAM_MAP = {
    'ARS': 'Arsenal',
    'AST': 'Aston Villa',
    'BOU': 'Bournemouth',
    'BHA': 'Brighton',
    'BRN': 'Brentford',
    'BUR': 'Burnley',
    'CHE': 'Chelsea',
    'COV': 'Coventry',
    'CRY': 'Crystal Palace',
    'EVE': 'Everton',
    'FUL': 'Fulham',
    'HLL': 'Hull',
    'IPS': 'Ipswich Town',
    'LEE': 'Leeds',
    'LIV': 'Liverpool',
    'MCI': 'Manchester City',
    'MUN': 'Manchester United',
    'NEW': 'Newcastle',
    'FOR': 'Nottm Forest',
    'SUN': 'Sunderland',
    'TOT': 'Tottenham',
    'WOL': 'Wolves',
    'WHU': 'West Ham'
};

function formatTeamName(fifaCode, rawName) {
    if (fifaCode && TEAM_MAP[fifaCode]) {
        return TEAM_MAP[fifaCode];
    }
    if (rawName) {
        return rawName.split('_')
                     .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                     .join(' ');
    }
    return fifaCode || '';
}

function isSameDateTime(ts1, ts2) {
    if (!ts1 || !ts2) return false;
    
    // Numeric timestamp comparison - tolerance 75 seconds (rounds are every 180s, so 75s prevents cross-round collision)
    const n1 = typeof ts1 === 'number' ? ts1 : (!isNaN(Number(ts1)) ? Number(ts1) : NaN);
    const n2 = typeof ts2 === 'number' ? ts2 : (!isNaN(Number(ts2)) ? Number(ts2) : NaN);

    if (!isNaN(n1) && !isNaN(n2)) {
        const ms1 = n1 < 10000000000 ? n1 * 1000 : n1;
        const ms2 = n2 < 10000000000 ? n2 * 1000 : n2;
        return Math.abs(ms1 - ms2) <= 75 * 1000;
    }

    // Try Date parsing
    const d1 = new Date(isNaN(n1) ? ts1 : n1);
    const d2 = new Date(isNaN(n2) ? ts2 : n2);
    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
        return Math.abs(d1.getTime() - d2.getTime()) <= 75 * 1000;
    }

    // Fallback: compare "HH:MM" time strings
    const s1 = String(ts1).trim();
    const s2 = String(ts2).trim();
    const match1 = s1.match(/(\d{1,2}):(\d{2})/);
    const match2 = s2.match(/(\d{1,2}):(\d{2})/);
    if (match1 && match2) {
        const m1 = parseInt(match1[1], 10) * 60 + parseInt(match1[2], 10);
        const m2 = parseInt(match2[1], 10) * 60 + parseInt(match2[2], 10);
        const diff = Math.abs(m1 - m2);
        return diff <= 5 || diff >= (24 * 60 - 5);
    }

    return false;
}

function formatWeekDate(timestamp) {
    if (!timestamp) return 'Unknown Date';
    const date = new Date(isNaN(Number(timestamp)) ? timestamp : Number(timestamp));
    if (isNaN(date.getTime())) return 'Unknown Date';
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Africa/Lagos'
        }).formatToParts(date);
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const hour = parts.find(p => p.type === 'hour').value;
        const minute = parts.find(p => p.type === 'minute').value;
        return `${year}-${month}-${day} ${hour}:${minute}`;
    } catch (e) {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
    }
}

function getSportySeasonName(leagueName, matchDay, eventTime) {
    const timeStr = formatWeekDate(eventTime);
    return `${leagueName} - Week ${matchDay} (${timeStr})`;
}


function initLiveTables(db) {
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 30000');
    } catch (_) {}
    db.exec(`
        CREATE TABLE IF NOT EXISTS live_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            predicted_result TEXT,
            predicted_probs TEXT,
            actual_score TEXT,
            actual_ht_score TEXT,
            scored_status INTEGER DEFAULT 0,
            ai_reasoning TEXT,
            anomaly_detected INTEGER DEFAULT 0,
            league_id INTEGER,
            UNIQUE(season_name, home_team, away_team) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS ai_best_picks_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            pick_type TEXT,
            home_team TEXT,
            away_team TEXT,
            market TEXT,
            probability INTEGER,
            implied_odd REAL,
            actual_score TEXT,
            status TEXT DEFAULT 'pending',
            UNIQUE(season_name, round_number, pick_type) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS sporty_fixtures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            ht_home_score INTEGER,
            ht_away_score INTEGER,
            home_score INTEGER,
            away_score INTEGER,
            bookmaker_odds TEXT,
            UNIQUE(season_name, home_team, away_team) ON CONFLICT IGNORE
        );

        CREATE VIEW IF NOT EXISTS betting_analytics AS 
        SELECT * FROM sporty_fixtures;

        CREATE TABLE IF NOT EXISTS historical_market_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT,
            season_name TEXT,
            round_number INTEGER,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            predicted_probs TEXT,
            actual_score TEXT,
            actual_ht_score TEXT,
            kickoff_timestamp INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(provider, season_name, round_number, home_team, away_team) ON CONFLICT IGNORE
        );
    `);

    const columnsToEnsure = [
        { name: 'round_number', type: 'INTEGER' },
        { name: 'ai_reasoning', type: 'TEXT' },
        { name: 'anomaly_detected', type: 'INTEGER DEFAULT 0' },
        { name: 'scored_with_prediction', type: 'INTEGER DEFAULT 1' },
        { name: 'kickoff_timestamp', type: 'INTEGER' },
        { name: 'league_id', type: 'INTEGER' },
        { name: 'bookmaker_odds', type: 'TEXT' }
    ];

    for (const col of columnsToEnsure) {
        try {
            db.exec(`ALTER TABLE live_predictions ADD COLUMN ${col.name} ${col.type}`);
        } catch (e) {
            // ignore if column already exists
        }
    }

    const aiColumnsToEnsure = [
        { name: 'kickoff_timestamp', type: 'INTEGER' },
        { name: 'match_time', type: 'TEXT' },
        { name: 'predicted_probs', type: 'TEXT' },
        { name: 'ev_score', type: 'REAL' },
        { name: 'calibrated_prob', type: 'REAL' },
        { name: 'recommendation_score', type: 'REAL' },
        { name: 'market_roi', type: 'REAL' },
        { name: 'league_roi', type: 'REAL' },
        { name: 'agreement_score', type: 'REAL' },
        { name: 'penalty_multiplier', type: 'REAL' },
        { name: 'displayed_confidence', type: 'REAL' },
        { name: 'bookmaker_implied_prob', type: 'REAL' }
    ];

    for (const col of aiColumnsToEnsure) {
        try {
            db.exec(`ALTER TABLE ai_best_picks_history ADD COLUMN ${col.name} ${col.type}`);
        } catch (e) {
            // ignore if column already exists
        }
    }

    // Backfill null kickoff_timestamp and match_time in ai_best_picks_history from live_predictions
    try {
        const nullAiRows = db.prepare("SELECT id, season_name, round_number, home_team, away_team FROM ai_best_picks_history WHERE kickoff_timestamp IS NULL OR match_time IS NULL LIMIT 200").all();
        if (nullAiRows && nullAiRows.length > 0) {
            const updateAiStmt = db.prepare("UPDATE ai_best_picks_history SET kickoff_timestamp = COALESCE(kickoff_timestamp, ?), match_time = COALESCE(match_time, ?) WHERE id = ?");
            const findMatchStmt = db.prepare("SELECT match_time, kickoff_timestamp FROM live_predictions WHERE home_team = ? AND away_team = ? AND season_name = ? AND round_number = ? ORDER BY id DESC LIMIT 1");
            for (const r of nullAiRows) {
                const matched = findMatchStmt.get(r.home_team, r.away_team, r.season_name, r.round_number);
                if (matched && (matched.kickoff_timestamp || matched.match_time)) {
                    updateAiStmt.run(matched.kickoff_timestamp || null, matched.match_time || null, r.id);
                }
            }
        }
    } catch (_) {}

    try {
        oddsAnalyzer.initOddsTable(db);
    } catch (e) {
        console.warn('Failed to initialize market odds history table in Sporty companion:', e.message);
    }

    try {
        db.exec("ALTER TABLE sporty_fixtures ADD COLUMN week INTEGER");
    } catch (e) {
        // ignore
    }

    try {
        db.exec("ALTER TABLE sporty_fixtures ADD COLUMN bookmaker_odds TEXT");
    } catch (e) {
        // ignore
    }
}

async function scrapeAndPredictLiveSportySeason(dbPath, isHeadless = true, targetLeagueId = 41104, isContinuous = false) {
    const db = new Database(dbPath);
    initLiveTables(db);

    // Trigger AI Meta-Optimizer automatically on startup if enabled in settings
    try {
        const weightsPath = `${dbPath}.weights.json`;
        let runNeeded = false;
        if (!fs.existsSync(weightsPath)) {
            runNeeded = true;
        } else {
            const stats = fs.statSync(weightsPath);
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs > 12 * 60 * 60 * 1000) { // Older than 12 hours
                runNeeded = true;
            }
        }
        if (runNeeded) {
            console.log("[AI Meta-Optimizer] Running automatic startup calibration...");
            const { runAIMetaOptimizer } = require('./ai_meta_optimizer');
            runAIMetaOptimizer(dbPath, 'sportybet')
                .then(res => {
                    if (res && res.success && res.optimized) {
                        console.log(`[AI Meta-Optimizer] Startup calibration applied successfully.`);
                    }
                })
                .catch(err => console.error('[AI Meta-Optimizer] Startup calibration failed:', err.message));
        }
    } catch (optErr) {
        console.error('[AI Meta-Optimizer] Failed to run startup calibration:', optErr.message);
    }

    let page, browser;
    let cleanupWsCapture = null;
    let directWs = null;
    try {
        console.log("🚀 Launching stealth browser for Sportybet live companion...");
        const result = await config.connect({ headless: isHeadless, provider: 'sportybet' });
        page = result;
        if (page.browser) browser = page.browser();
        await page.setViewport({ width: 966, height: 714 });

        // Forward stealth browser logs to the Node console
        page.on('console', msg => {
            const txt = msg.text();
            if (txt.includes('[Stealth Scraper]')) {
                console.log(txt);
            }
        });

        let eventTime = null;
        let upcomingMatchesScraped = [];
        let resultsScraped = [];
        let eventParticipantMap = new Map();
        let activeRoundNum = null;
        let createdSeasons = new Set();
        let backfilledSeasons = new Set(); // Track seasons already backfilled to avoid retrying blocked-market seasons
        let aiPicksQueue = []; // Serialised queue: process one season per tick, no concurrent DB writes
        let predictionsCreated = 0;
        let predictionsScored = 0;
        let consecutive401Count = 0;
        let lastSuccessfulDataTime = Date.now();
        let sessionNeedsRecovery = false;


        const mainSession = await page.target().createCDPSession();
        await mainSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

        // ── FAST-PATH: direct WebSocket connection to Golden Race ──────────────────
        // Enable Network events on the main page session so CDP reports the WS URL
        // before the child iframe target is even attached.
        try {
            await mainSession.send('Network.enable');
        } catch (e) {
            console.warn('[WS Direct] Could not enable Network on main session:', e.message);
        }
        // Helper: immediately score a result against live_predictions when it arrives
        // This is called DIRECTLY from the WS callback so scores are never missed
        function processResultNow(res) {
            try {
                const { homeTeam, awayTeam, htHome, htAway, homeScore, awayScore, eventTime } = res;
                if (!homeTeam || !awayTeam || homeScore == null) return;
                const ftScore = `${homeScore}:${awayScore}`;
                const htScore = `${htHome != null ? htHome : 0}:${htAway != null ? htAway : 0}`;

                const resultTimeMs = eventTime ? (isNaN(Number(eventTime)) ? new Date(eventTime).getTime() : Number(eventTime)) : null;

                // 1. Find matching unscored prediction in live_predictions
                const existingList = db.prepare(
                    'SELECT id, scored_status, kickoff_timestamp, season_name FROM live_predictions WHERE home_team = ? AND away_team = ? AND scored_status = 0 ORDER BY id DESC'
                ).all(homeTeam, awayTeam);

                let matchedLive = existingList.find(pred => {
                    // Do not score a match whose kickoff is in the future
                    if (pred.kickoff_timestamp && pred.kickoff_timestamp > Date.now() + 15 * 1000) {
                        return false;
                    }
                    if (!resultTimeMs) return true;
                    return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                }) || (existingList.length > 0 && (!existingList[0].kickoff_timestamp || existingList[0].kickoff_timestamp <= Date.now() + 15 * 1000) ? existingList[0] : null);

                if (matchedLive) {
                    const oddsJson = res.odds ? JSON.stringify(res.odds) : null;
                    db.prepare(`UPDATE live_predictions SET actual_score = ?, actual_ht_score = ?, scored_status = 1, bookmaker_odds = COALESCE(bookmaker_odds, ?) WHERE id = ?`)
                        .run(ftScore, htScore, oddsJson, matchedLive.id);
                    predictionsScored++;
                }

                // 2. Find and score matching prediction in historical_market_predictions (regardless of live_predictions)
                const historicalList = db.prepare(`
                    SELECT id, kickoff_timestamp 
                    FROM historical_market_predictions 
                    WHERE provider = 'sportybet' AND home_team = ? AND away_team = ? AND actual_score IS NULL
                    ORDER BY id DESC
                `).all(homeTeam, awayTeam);

                const targetHist = historicalList.find(pred => {
                    if (pred.kickoff_timestamp && pred.kickoff_timestamp > Date.now() + 15 * 1000) return false;
                    if (!resultTimeMs) return true;
                    return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                }) || (historicalList.length > 0 && (!historicalList[0].kickoff_timestamp || historicalList[0].kickoff_timestamp <= Date.now() + 15 * 1000) ? historicalList[0] : null);

                if (targetHist) {
                    db.prepare(`UPDATE historical_market_predictions SET actual_score = ?, actual_ht_score = ? WHERE id = ?`)
                        .run(ftScore, htScore, targetHist.id);
                }

                // 3. Score and settle ai_best_picks_history directly for this match
                let aiPicksSettled = 0;
                try {
                    const pendingPicks = db.prepare(`
                        SELECT id, market, kickoff_timestamp 
                        FROM ai_best_picks_history 
                        WHERE home_team = ? AND away_team = ? AND status = 'pending'
                        ORDER BY id DESC
                    `).all(homeTeam, awayTeam);

                    for (const pick of pendingPicks) {
                        const isMatch = !resultTimeMs || !pick.kickoff_timestamp || isSameDateTime(resultTimeMs, pick.kickoff_timestamp);
                        if (isMatch) {
                            const finalStatus = typeof evaluatePickOutcome === 'function' ? evaluatePickOutcome(pick.market, ftScore, htScore) : null;
                            if (finalStatus) {
                                db.prepare(`UPDATE ai_best_picks_history SET actual_score = ?, status = ? WHERE id = ?`)
                                    .run(ftScore, finalStatus, pick.id);
                                aiPicksSettled++;
                                try {
                                    settlementLogger.settled({
                                        id: pick.id,
                                        home_team: homeTeam,
                                        away_team: awayTeam,
                                        market: pick.market,
                                        actual_score: ftScore,
                                        actual_ht_score: htScore,
                                        status: finalStatus,
                                        season_name: seasonName,
                                        round_number: roundNum
                                    });
                                } catch (_) {}
                            }
                        }
                    }
                } catch (e) {
                    console.error('[WS Direct] Error directly settling AI picks:', e.message);
                }

                if (matchedLive || targetHist || aiPicksSettled > 0) {
                    console.log(`[WS Direct] ✅ Scored: ${homeTeam} ${ftScore} ${awayTeam} (Live: ${matchedLive ? 1 : 0}, Hist: ${targetHist ? 1 : 0}, AIPicks: ${aiPicksSettled})`);
                    try {
                        settlementLogger.matchScored(homeTeam, awayTeam, ftScore, htScore, source || 'ws');
                    } catch (_) {}
                }

                // 4. Also call settlePendingAIPicks to catch any dependent picks
                try {
                    settlePendingAIPicks(db);
                } catch (_) {}

                // 5. Broadcast settled results to Telegram
                try {
                    const { broadcastSettledResults } = require('./telegram_broadcaster');
                    broadcastSettledResults(db).catch(() => {});
                } catch (_) {}
            } catch(e) {
                console.error('[WS Direct] Error scoring result:', e.message);
            }
        }

        // Fast-path direct WS is disabled to prevent spurious 401 unauthorized errors.
        // The stealth scraper reliably intercepts all WebSocket frames via childSession.
        cleanupWsCapture = null;
        directWs = null;

        mainSession.on('Target.attachedToTarget', async ({ sessionId }) => {
            const childSession = mainSession.connection().session(sessionId);
            if (!childSession) return;
            try {
                await childSession.send('Network.enable');

                childSession.on('Network.webSocketFrameReceived', ({ response }) => {
                    try {
                        const payload = response.payloadData;
                        if (!payload || !payload.startsWith('{')) return;
                        const parsed = JSON.parse(payload);
                        
                        // Telemetry logging and watchdog tracking for websocket payloads
                        if (parsed.type === 'RESPONSE' && parsed.res) {
                            const resName = parsed.res.resource || '';
                            const hasBody = Array.isArray(parsed.res.body);
                            if (resName.includes('eventBlocks')) {
                                console.log(`[Stealth Scraper] [WS RESPONSE] Resource: ${resName}, Status: ${parsed.res.statusCode}, hasBody: ${hasBody}`);
                            }
                            if (parsed.res.statusCode === 401 || parsed.res.statusCode === 403) {
                                consecutive401Count++;
                                if (consecutive401Count >= 3) {
                                    console.log('[Watchdog] ⚠️ Consecutive 401 Unauthorized detected from Sportybet Golden Race. Flagging for session refresh.');
                                    sessionNeedsRecovery = true;
                                }
                            } else if (parsed.res.statusCode === 200) {
                                consecutive401Count = 0;
                                if (resName.includes('eventBlocks') && hasBody) {
                                    lastSuccessfulDataTime = Date.now();
                                }
                            }
                        }

                        if (parsed.type !== 'RESPONSE' || !parsed.res || parsed.res.statusCode !== 200) return;
                        const resource = parsed.res.resource;
                        const rawBody = parsed.res.body;
                        const blocks = Array.isArray(rawBody) ? rawBody : (rawBody ? [rawBody] : []);
                        if (!blocks.length) return;

                        if (resource === '/eventBlocks/find' || resource === '/eventBlocks/event/data') {
                            let matchedBlocks = 0;
                            let matchedEvents = 0;
                            for (const block of blocks) {
                                // Relax multi check to capture both styles
                                if (!block.events) continue;
                                if (String(block.playlistId) !== String(targetLeagueId)) {
                                    continue;
                                }
                                matchedBlocks++;
                                
                                if (block.eventTime) {
                                    if (!eventTime || block.eventTime < eventTime) {
                                        eventTime = block.eventTime;
                                    }
                                }
                                const matchDay = block.data?.matchDay || block.data?.matchday || block.data?.weekDay || block.data?.legOrd || 0;
                                if (matchDay > 0) {
                                    if (activeRoundNum === null || matchDay > activeRoundNum || (matchDay === 1 && activeRoundNum >= 30)) {
                                        activeRoundNum = matchDay;
                                    }
                                }

                                for (const event of block.events) {
                                    if (!event.data || !event.data.participants || event.data.participants.length < 2) continue;
                                    matchedEvents++;

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

                                    const hTeam = formatTeamName(event.data.participants[0].fifaCode, event.data.participants[0].name);
                                    const aTeam = formatTeamName(event.data.participants[1].fifaCode, event.data.participants[1].name);

                                    const evId = event.eventId || event.id || event.data?.eventId || (event.data?.participants ? `${event.data.participants[0].fifaCode}_${event.data.participants[1].fifaCode}` : null);
                                    if (evId) {
                                        eventParticipantMap.set(String(evId), {
                                            homeTeam: hTeam,
                                            awayTeam: aTeam,
                                            matchDay,
                                            eventTime: block.eventTime
                                        });
                                    }

                                    upcomingMatchesScraped.push({
                                        homeTeam: hTeam,
                                        awayTeam: aTeam,
                                        matchDay,
                                        eventTime: block.eventTime,
                                        odds: parsedOdds
                                    });
                                }
                            }
                            if (matchedBlocks > 0) {
                                console.log(`[Stealth Scraper] Parsed ${matchedEvents} events from ${matchedBlocks} blocks for resource ${resource}`);
                            }
                        } else if (resource === '/eventBlocks/event/result') {
                            let matchedResults = 0;
                            for (const block of blocks) {
                                if (!block.events) continue;
                                const bPlaylist = block.playlistId || block.data?.playlistId;
                                if (bPlaylist && String(bPlaylist) !== String(targetLeagueId)) continue;

                                for (const event of block.events) {
                                    const p0 = event.data?.participants?.[0] || event.participants?.[0];
                                    const p1 = event.data?.participants?.[1] || event.participants?.[1];
                                    let homeTeam = p0 ? formatTeamName(p0.fifaCode, p0.name) : null;
                                    let awayTeam = p1 ? formatTeamName(p1.fifaCode, p1.name) : null;

                                    const evId = event.eventId || event.id || event.result?.eventId || event.result?.data?.eventId;
                                    if ((!homeTeam || !awayTeam) && evId && eventParticipantMap.has(String(evId))) {
                                        const cached = eventParticipantMap.get(String(evId));
                                        homeTeam = cached.homeTeam;
                                        awayTeam = cached.awayTeam;
                                    }

                                    if (!homeTeam || !awayTeam) continue;

                                    const scores = event.result?.finalOutcome || event.scores || event.result?.scores;
                                    if (!Array.isArray(scores) || scores.length < 4) continue;

                                    matchedResults++;
                                    const resultObj = {
                                        homeTeam,
                                        awayTeam,
                                        htHome: parseInt(scores[0], 10),
                                        htAway: parseInt(scores[1], 10),
                                        homeScore: parseInt(scores[0], 10) + parseInt(scores[2], 10),
                                        awayScore: parseInt(scores[1], 10) + parseInt(scores[3], 10),
                                        eventTime: block.eventTime
                                    };
                                    resultsScraped.push(resultObj);
                                    processResultNow(resultObj);
                                }
                            }
                            if (matchedResults > 0) {
                                console.log(`[Stealth Scraper] Parsed ${matchedResults} completed match results for resource ${resource}`);
                            }
                        }
                    } catch (e) {
                        console.error(`[Stealth Scraper] [WS Parse Error]:`, e.message);
                    }
                });
            } catch (e) {
                console.error(`[Stealth Scraper] [WS Session Error]:`, e.message);
            }
        });

        console.log("🌐 Navigating to Sportybet Virtuals...");
        await page.goto('https://www.sportybet.com/ng/virtual/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        console.log("⏳ Waiting 12s for Golden Race iframe...");
        await delay(12000);

        const LEAGUE_NAME_MAP = {
            41104: "England",
            41110: "Italy",
            41108: "Germany",
            41113: "Spain",
            41106: "France",
            41114: "Turkey"
        };
        const targetLeagueName = LEAGUE_NAME_MAP[targetLeagueId] || "England";

        let iframe = null;
        let attempts = 0;
        while (!iframe && attempts < 15) {
            iframe = await resolveSportyIframe(page);
            if (!iframe) {
                console.log(`⏳ Waiting for Sportybet/Golden Race iframe (Attempt ${attempts + 1}/15)...`);
                await delay(2000);
            }
            attempts++;
        }

        if (iframe) {
            console.log(`✅ Found Sportybet/Golden Race iframe! Switching to ${targetLeagueName} and triggering week selectors...`);
            try {
                try {
                    console.log("⏳ Waiting for Golden Race layout elements to load inside iframe...");
                    await iframe.waitForSelector('#game_league, a.toggler, .gr-icon-league, a[title="Football League"]', { timeout: 20000 });
                } catch (err) {
                    console.warn("⚠️ Timeout waiting for Golden Race menu elements inside iframe:", err.message);
                }
                const evalResult = await iframe.evaluate(async (leagueName, leagueId) => {
                    const delay = (ms) => new Promise(r => setTimeout(r, ms));
                    const logs = [];
                    const log = (msg) => {
                        logs.push(msg);
                        console.log(msg);
                    };
                    
                    const triggerClick = (el) => {
                        if (!el) return false;
                        try {
                            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            return true;
                        } catch (err) {
                            log(`[Stealth Scraper] dispatchEvent click failed: ${err.message}`);
                            try {
                                el.click();
                                return true;
                            } catch (e) {
                                return false;
                            }
                        }
                    };

                    const clickEl = async (el, waitMs = 0) => {
                        if (!el) return false;
                        const tag = el.tagName.toLowerCase();
                        const cls = (el.className || '').toString().toLowerCase();
                        log(`[Stealth Scraper] Dispatching realistic click on <${tag} class="${cls}">`);
                        const clicked = triggerClick(el);
                        if (clicked && waitMs > 0) {
                            await delay(waitMs);
                        }
                        return clicked;
                    };

                    const getTogglerSelector = () => {
                        const toggler = document.querySelector('#game_league > a') ||
                                        document.querySelector('a.toggler[title="Football League"]') ||
                                        document.querySelector('a.toggler.gr-icon-league') ||
                                        Array.from(document.querySelectorAll('a.toggler')).find(el => el.textContent.trim().toLowerCase().includes('football league'));
                        return toggler || null;
                    };

                    const getLeagueSelector = () => {
                        const isSidebarElement = (el) => {
                            if (!el) return false;
                            return el.closest('#game_league') || 
                                   el.closest('[id*="playlist"]') || 
                                   el.closest('.sidebar') || 
                                   el.closest('.menu') || 
                                   el.closest('.navigation') || 
                                   el.closest('.playlist') ||
                                   el.closest('.playlist-container');
                        };

                        const playlistEl = document.querySelector('#playlist_' + leagueId + ' > a') ||
                                           document.querySelector('#playlist_' + leagueId + ' a') ||
                                           Array.from(document.querySelectorAll('a[title="' + leagueName + '"]')).find(isSidebarElement);
                        return playlistEl || null;
                    };

                    let leagueEl = getLeagueSelector();
                    if (leagueEl) {
                        log(`[Stealth Scraper] League "${leagueName}" is already visible. Skipping "Football League" click.`);
                    } else {
                        log(`[Stealth Scraper] League "${leagueName}" is not visible. Expanding "Football League" accordion...`);
                        
                        const toggler = getTogglerSelector();
                        if (toggler && (toggler.classList.contains('collapsed') || (toggler.className || '').toString().includes('collapsed'))) {
                            log(`[Stealth Scraper] Found Football League toggler is collapsed. Clicking...`);
                            await clickEl(toggler, 2000); // Wait 2s for sidebar animation to expand
                            leagueEl = getLeagueSelector();
                        } else if (toggler) {
                            log(`[Stealth Scraper] Football League toggler is already expanded.`);
                            leagueEl = getLeagueSelector();
                        } else {
                            log(`[Stealth Scraper] Warning: Football League toggler not found.`);
                        }
                    }

                    if (leagueEl) {
                        log(`[Stealth Scraper] Clicking league element "${leagueName}"...`);
                        await clickEl(leagueEl, 4000); // Wait 4s for league page to load
                    } else {
                        log(`[Stealth Scraper] Warning: League element "${leagueName}" not visible even after expansion attempt.`);
                    }

                    // Enforce Golden Race Angular hash route directly to target playlist
                    try {
                        const targetHash = `#/scheduled/league/playlist/${leagueId}`;
                        if (!window.location.hash.includes(`playlist/${leagueId}`)) {
                            log(`[Stealth Scraper] Direct hash navigation to: ${targetHash}`);
                            window.location.hash = targetHash;
                            await delay(3000);
                        }
                    } catch (hashErr) {
                        log(`[Stealth Scraper] Warning during hash navigation: ${hashErr.message}`);
                    }

                    // Step 3: Click horizontal round selector buttons inside iframe
                    const weekElements = Array.from(document.querySelectorAll('*')).filter(el => {
                        if (el.children.length > 0) return false; // leaf nodes only
                        const text = el.textContent.trim();
                        const isNum = /^\d+$/.test(text);
                        if (isNum) {
                            const val = parseInt(text, 10);
                            if (val >= 1 && val <= 38) {
                                let parent = el.parentElement;
                                let depth = 0;
                                while (parent && depth < 4) {
                                    const parentText = parent.textContent.toLowerCase();
                                    const parentClass = (parent.className || '').toString().toLowerCase();
                                    const hasContext = parentText.includes('week') || 
                                                       parentText.includes('matchday') || 
                                                       parentText.includes('round') || 
                                                       parentClass.includes('scheduler') || 
                                                       parentClass.includes('nav') ||
                                                       parentClass.includes('tabs') ||
                                                       parentClass.includes('menu');
                                    if (hasContext) return true;
                                    parent = parent.parentElement;
                                    depth++;
                                }
                            }
                        }
                        return text.startsWith('Week ') || text.startsWith('W ') || text.startsWith('Round ');
                    });

                    log(`[Stealth Scraper] Clicking ${weekElements.length} visible week selectors...`);
                    for (const el of weekElements) {
                        try {
                            el.click();
                            await delay(1000); // Let the WebSocket payload stream in
                        } catch (clickErr) {}
                    }

                    // Try to click the right scroll arrow to reveal more weeks
                    const rightArrow = Array.from(document.querySelectorAll('*')).find(el => {
                        const classStr = (el.className || '').toString().toLowerCase();
                        return classStr.includes('icon-arrow-right') || classStr.includes('nav-next') || classStr.includes('scroll-right') || el.getAttribute('aria-label') === 'Next';
                    });
                    
                    if (rightArrow && rightArrow.offsetParent !== null) {
                        log(`[Stealth Scraper] Clicking right-scroll arrow to reveal more weeks...`);
                        await clickEl(rightArrow, 1000);
                        
                        // Re-query week elements after scrolling
                        const moreWeekElements = Array.from(document.querySelectorAll('*')).filter(el => {
                            if (el.children.length > 0) return false;
                            const text = el.textContent.trim();
                            return text.startsWith('Week ') || text.startsWith('W ') || text.startsWith('Round ');
                        });
                        
                        const newWeeks = moreWeekElements.filter(nw => !weekElements.includes(nw));
                        if (newWeeks.length > 0) {
                            log(`[Stealth Scraper] Clicking ${newWeeks.length} newly revealed week selectors...`);
                            for (const el of newWeeks) {
                                try {
                                    el.click();
                                    await delay(1000);
                                } catch (clickErr) {}
                            }
                        }
                    }

                    return { success: !!leagueEl, logs, clickedWeeks: weekElements.length };
                }, targetLeagueName, targetLeagueId);

                if (evalResult && evalResult.logs) {
                    for (const msg of evalResult.logs) {
                        console.log(msg);
                    }
                }

                console.log("[Stealth Scraper] Simulating human keypress navigation (ArrowLeft/ArrowDown/ArrowUp)...");
                try {
                                const iframeElement = await page.$(SPORTY_IFRAME_SELECTOR);
                        await delay(500);

                        console.log("   ↳ Pressing ArrowLeft 4 times...");
                        for (let i = 0; i < 4; i++) {
                            await page.keyboard.press('ArrowLeft');
                            await delay(100 + Math.random() * 50);
                        }
                        await delay(500);

                        console.log("   ↳ Pressing ArrowDown 45 times...");
                        for (let i = 0; i < 45; i++) {
                            await page.keyboard.press('ArrowDown');
                            await delay(50 + Math.random() * 30);
                        }
                        await delay(500);

                        console.log("   ↳ Pressing ArrowUp 45 times...");
                        for (let i = 0; i < 45; i++) {
                            await page.keyboard.press('ArrowUp');
                            await delay(50 + Math.random() * 30);
                        }
                        await delay(500);
                } catch (navErr) {
                    console.warn("⚠️ Warning during stealth navigation keypresses:", navErr.message);
                }

                console.log("🕒 Waiting 5s for final WebSocket payloads to stream in...");
                await delay(5000);
            } catch (evalErr) {
                console.error("⚠️ Error while evaluating week selectors in iframe:", evalErr.message);
                console.log("🕒 Falling back to a 10s wait for WebSocket payloads...");
                await delay(10000);
            }
        } else {
            console.log("⚠️ Golden Race iframe not found directly. Waiting 15s for default payload streams...");
            await delay(15000);
        }

        const PLAYLIST_LEAGUE_MAP = {
            41104: "Sportybet England",
            41110: "Sportybet Italy",
            41108: "Sportybet Germany",
            41113: "Sportybet Spain",
            41106: "Sportybet France",
            41114: "Sportybet Turkey"
        };
        const leagueName = PLAYLIST_LEAGUE_MAP[targetLeagueId] || "Sportybet England";
        const activeSeasonName = `${leagueName} Live`;

        // DB Operations

        let decayRate = 0.015;
        let poissonWeight = 0.6;
        let poissonWeightDraw = 0.6;
        let poissonWeightWin = 0.6;
        const weightsPath = `${dbPath}.weights.json`;
        if (fs.existsSync(weightsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
                if (typeof data.decayRate === 'number') decayRate = data.decayRate;
                if (typeof data.poissonWeight === 'number') {
                    poissonWeight = data.poissonWeight;
                    poissonWeightDraw = typeof data.poissonWeightDraw === 'number' ? data.poissonWeightDraw : poissonWeight;
                    poissonWeightWin = typeof data.poissonWeightWin === 'number' ? data.poissonWeightWin : poissonWeight;
                }
            } catch (e) {}
        }

        const insertPred = db.prepare(`
            INSERT OR IGNORE INTO live_predictions (
                season_name, round_number, match_time, home_team, away_team, predicted_result, predicted_probs, scored_status, ai_reasoning, anomaly_detected, kickoff_timestamp, league_id, bookmaker_odds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        `);

        const insertHistoricalPred = db.prepare(`
            INSERT OR IGNORE INTO historical_market_predictions (
                provider, season_name, round_number, match_time, home_team, away_team, predicted_probs, kickoff_timestamp
            ) VALUES ('sportybet', ?, ?, ?, ?, ?, ?, ?)
        `);

        const updateScore = db.prepare(`
            UPDATE live_predictions
            SET actual_score = ?, actual_ht_score = ?, scored_status = 1
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND scored_status = 0
        `);

        const updateHistoricalScore = db.prepare(`
            UPDATE historical_market_predictions
            SET actual_score = ?, actual_ht_score = ?
            WHERE provider = 'sportybet' AND season_name = ? AND home_team = ? AND away_team = ? AND actual_score IS NULL
        `);

        // Check if round reset to early season, if so, archive old season (cleanup live_predictions)
        if (activeRoundNum <= 5) {
            const maxRoundRow = db.prepare("SELECT MAX(round_number) as max_r FROM live_predictions WHERE season_name = ?").get(activeSeasonName);
            if (maxRoundRow && maxRoundRow.max_r >= 38) {
                console.log("🧹 New Sportybet season detected. Archiving old live predictions...");
                const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ? AND scored_status = 1").all(activeSeasonName);
                const insertFixture = db.prepare(`
                    INSERT OR IGNORE INTO sporty_fixtures (
                        league_name, season_name, match_time, home_team, away_team,
                        ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                for (const m of completedMatches) {
                    if (m.actual_score) {
                        const scores = m.actual_score.split(':').map(Number);
                        const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                        // Make up a season name for the archive
                        const dateStr = new Date().toISOString().slice(0,10);
                        insertFixture.run(leagueName, `Season ${dateStr}`, m.match_time, m.home_team, m.away_team, htScores[0], htScores[1], scores[0], scores[1], m.bookmaker_odds);
                    }
                }
                db.prepare("DELETE FROM live_predictions WHERE season_name = ?").run(activeSeasonName);

                try {
                    console.log("📈 Re-optimizing ML blending weights and decay rate with newly archived season data...");
                    const optResult = optimizeBlendingWeights(dbPath, 'sportybet');
                    console.log(`📊 ML Optimization completed: Poisson Weight: ${optResult.poissonWeight}, Elo Weight: ${optResult.eloWeight}, Decay Rate: ${optResult.decayRate}, Brier Score: ${optResult.brierScore}`);
                } catch (optErr) {
                    console.error("⚠️ Failed to optimize blending weights:", optErr.message);
                }

                // Trigger AI Meta-Optimizer asynchronously to update decay rate / poisson weights using configured LLM
                try {
                    const { runAIMetaOptimizer } = require('./ai_meta_optimizer');
                    runAIMetaOptimizer(dbPath, 'sportybet')
                        .then(res => {
                            if (res && res.success && res.optimized) {
                                console.log(`[AI Meta-Optimizer] New parameters successfully applied: decayRate=${res.decayRate}, poissonWeight=${res.poissonWeight}`);
                            }
                        })
                        .catch(optErr => console.error('[AI Meta-Optimizer] Error running season optimizer:', optErr.message));
                } catch (optErr) {
                    console.error('[AI Meta-Optimizer] Failed to load optimizer module:', optErr.message);
                }
            }
        }

        predictionsCreated = 0;
        predictionsScored = 0;
        let lastClickTime = Date.now();

        // ── STARTUP BACKFILL: score any stale predictions from historical results ─────
        // Runs once on startup to immediately score pending predictions from any past
        // results stored in sporty_fixtures or fixtures tables.
        try {
            const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
            const hasSportyFixtures = tableNames.includes('sporty_fixtures');
            const hasFixtures = tableNames.includes('fixtures');

            if (hasSportyFixtures || hasFixtures) {
                const stalePending = db.prepare(`
                    SELECT id, home_team, away_team, season_name, kickoff_timestamp
                    FROM live_predictions
                    WHERE scored_status = 0 AND actual_score IS NULL
                `).all();

                let backfilled = 0;
                for (const pred of stalePending) {
                    let fix = null;

                    // Try sporty_fixtures first (primary sportybet archive)
                    if (hasSportyFixtures) {
                        const candidates = db.prepare(`
                            SELECT home_score, away_score, ht_home_score, ht_away_score, match_time
                            FROM sporty_fixtures
                            WHERE home_team = ? AND away_team = ?
                        `).all(pred.home_team, pred.away_team);

                        fix = candidates.find(candidate => {
                            if (!pred.kickoff_timestamp) return true; // fallback
                            return isSameDateTime(pred.kickoff_timestamp, candidate.match_time);
                        });
                    }

                    // Fall back to fixtures table (Bet9ja / general archive)
                    if (!fix && hasFixtures) {
                        const candidates = db.prepare(`
                            SELECT home_score, away_score, ht_home_score, ht_away_score, match_time
                            FROM fixtures
                            WHERE home_team = ? AND away_team = ?
                        `).all(pred.home_team, pred.away_team);

                        fix = candidates.find(candidate => {
                            if (!pred.kickoff_timestamp) return true;
                            return isSameDateTime(pred.kickoff_timestamp, candidate.match_time);
                        });
                    }

                    if (fix && fix.home_score != null) {
                        const ftScore = `${fix.home_score}:${fix.away_score}`;
                        const htScore = `${fix.ht_home_score || 0}:${fix.ht_away_score || 0}`;
                        db.prepare(`UPDATE live_predictions SET actual_score = ?, actual_ht_score = ?, scored_status = 1 WHERE id = ?`)
                            .run(ftScore, htScore, pred.id);
                        try {
                            // Find and score matching historical prediction
                            const historicalList = db.prepare(`
                                SELECT id, kickoff_timestamp 
                                FROM historical_market_predictions 
                                WHERE provider = 'sportybet' AND season_name = ? AND home_team = ? AND away_team = ? AND actual_score IS NULL
                            `).all(pred.season_name, pred.home_team, pred.away_team);

                            const targetHist = historicalList.find(hPred => {
                                if (!pred.kickoff_timestamp) return true;
                                return isSameDateTime(pred.kickoff_timestamp, hPred.kickoff_timestamp);
                            });

                            if (targetHist) {
                                db.prepare(`UPDATE historical_market_predictions SET actual_score = ?, actual_ht_score = ? WHERE id = ?`)
                                    .run(ftScore, htScore, targetHist.id);
                            }
                        } catch(e) {}
                        backfilled++;
                    }
                }
                console.log(`[Backfill] ✅ Scored ${backfilled}/${stalePending.length} stale pending predictions from historical fixtures.`);
                predictionsScored += backfilled;
            }
        } catch(backfillErr) {
            console.error('[Backfill] Error during startup backfill:', backfillErr.message);
        }
        // ── END STARTUP BACKFILL ────────────────────────────────────────────────────


        console.log("🔄 Starting continuous live companion scraping loop...");
        let iframeMissCount = 0;
        while (true) {
            try {
                // Check if page or browser is closed
                if (page.isClosed() || (browser && !browser.isConnected())) {
                    console.log("🔌 Browser or page closed. Exiting live companion loop...");
                    break;
                }

                // Reload weights dynamically in case they were updated by the AI Optimizer or manual changes
                try {
                    if (fs.existsSync(weightsPath)) {
                        const wData = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
                        if (typeof wData.decayRate === 'number') decayRate = wData.decayRate;
                        if (typeof wData.poissonWeight === 'number') {
                            poissonWeight = wData.poissonWeight;
                            poissonWeightDraw = typeof wData.poissonWeightDraw === 'number' ? wData.poissonWeightDraw : poissonWeight;
                            poissonWeightWin = typeof wData.poissonWeightWin === 'number' ? wData.poissonWeightWin : poissonWeight;
                        }
                    }
                } catch (wErr) {
                    // Ignore read errors
                }


                // Clean up stale unplayed predictions (older than 2 hours)
                const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
                const deletedOld = db.prepare(`
                    DELETE FROM live_predictions 
                    WHERE season_name LIKE 'Sportybet%' AND scored_status = 0 AND kickoff_timestamp < ?
                `).run(twoHoursAgo);
                if (deletedOld.changes > 0) {
                    console.log(`🧹 Cleared ${deletedOld.changes} stale unplayed predictions older than 2 hours.`);
                }

                // Dynamically resolve iframe to avoid stale/detached references
                let activeIframe = (await resolveSportyIframe(page)) || iframe;

                // ── PAGE-LEVEL RECOVERY: If the iframe is gone the page navigated away ──────
                if (!activeIframe || activeIframe.isDetached()) {
                    iframeMissCount++;
                    try {
                        const currentUrl = page.url();
                        if (!currentUrl.includes('sportybet.com') || iframeMissCount >= 3) {
                            console.log(`[League Guard] Sportybet page lost or iframe missing for ${iframeMissCount} cycles — re-navigating to virtuals...`);
                            await page.goto('https://www.sportybet.com/ng/virtual/', { waitUntil: 'domcontentloaded', timeout: 45000 });
                            await delay(12000);
                            iframeMissCount = 0;
                        } else {
                            console.log(`[League Guard] Still on Sportybet but iframe gone — waiting 8s for iframe to reappear (miss ${iframeMissCount}/3)...`);
                            await delay(8000);
                        }
                        // Re-resolve iframe after recovery wait
                        activeIframe = await resolveSportyIframe(page);
                        if (activeIframe) {
                            console.log('[League Guard] Iframe recovered. Will re-select league on next 30s tick.');
                            iframeMissCount = 0;
                            lastClickTime = 0; // Force immediate league re-selection on next iteration
                        } else {
                            console.log('[League Guard] Iframe still not found. Will retry next cycle.');
                        }
                    } catch (recoveryErr) {
                        console.error('[League Guard] Page recovery failed:', recoveryErr.message);
                    }
                } else {
                    iframeMissCount = 0;
                }

                // ── WATCHDOG SELF-HEALING RECOVERY ──────────────────────────────────────────
                // Automatically recovers if Golden Race returns 401/403 or no live events arrive for > 8 minutes
                const isDataStalled = (Date.now() - lastSuccessfulDataTime > 8 * 60 * 1000);
                if (sessionNeedsRecovery || isDataStalled) {
                    const reason = sessionNeedsRecovery ? 'Expired 401 Session' : 'Data stall > 8 minutes';
                    console.log(`[Watchdog] 🔄 Self-healing recovery triggered (${reason}). Refreshing page to acquire new session & tokens...`);
                    try { scraperLogger.warn(`Watchdog self-healing recovery triggered (${reason})`, { reason }); } catch (_) {}
                    sessionNeedsRecovery = false;
                    consecutive401Count = 0;
                    lastSuccessfulDataTime = Date.now();

                    if (directWs) {
                        try { directWs.destroy(); } catch (_) {}
                        directWs = null;
                    }
                    if (cleanupWsCapture && typeof cleanupWsCapture.reset === 'function') {
                        cleanupWsCapture.reset();
                    }

                    try {
                        await page.goto('https://www.sportybet.com/ng/virtual/', { waitUntil: 'domcontentloaded', timeout: 45000 });
                        await delay(12000);
                        activeIframe = await resolveSportyIframe(page);
                        lastClickTime = 0; // Force immediate league re-select
                        console.log('[Watchdog] ✅ Page re-navigated successfully. Fresh Golden Race session initialized.');
                    } catch (recErr) {
                        console.error('[Watchdog] Recovery navigation failed:', recErr.message);
                    }
                }

                // Scrape week countdown timers from Golden Race iframe and clear expired weeks
                if (activeIframe) {
                    try {
                        let timers = [];
                        try {
                            timers = await activeIframe.evaluate(() => {
                                const results = [];
                                const countdownElements = Array.from(document.querySelectorAll('app-countdown'));
                                for (const el of countdownElements) {
                                    const timeText = el.textContent.trim();
                                    if (!timeText || !timeText.includes(':')) continue;

                                    // Resolve week number
                                    let weekNum = null;
                                    let current = el;
                                    let depth = 0;
                                    while (current && depth < 6) {
                                        // Strip timeText from textContent to avoid matching MM or SS from MM:SS
                                        const txt = (current.textContent || '').replace(timeText, '').trim();
                                        const match = txt.match(/(?:Week|W|Round)?\s*(\d+)/i);
                                        if (match) {
                                            const parsed = parseInt(match[1], 10);
                                            if (parsed >= 1 && parsed <= 38) {
                                                weekNum = parsed;
                                                break;
                                            }
                                        }
                                        current = current.parentElement;
                                        depth++;
                                    }

                                    if (weekNum !== null) {
                                        results.push({ weekNum, timeText });
                                    }
                                }
                                return results;
                            });
                        } catch (e) {
                            console.log("[Timer Engine] DOM evaluation error inside iframe (page might be loading):", e.message);
                        }

                        // Mathematical fallback: If DOM timers are empty, resolve from DB kickoff_timestamp
                        if (!timers || timers.length === 0) {
                            timers = [];
                            try {
                                const dbRounds = db.prepare(`
                                    SELECT round_number, MIN(kickoff_timestamp) as kickoff 
                                    FROM live_predictions 
                                    WHERE season_name = ? AND scored_status = 0 
                                    GROUP BY round_number
                                `).all(activeSeasonName);

                                const now = Date.now();
                                for (const row of dbRounds) {
                                    if (!row.kickoff) continue;
                                    const kickoffMs = isNaN(Number(row.kickoff)) ? new Date(row.kickoff).getTime() : Number(row.kickoff);
                                    const diffSec = Math.max(0, Math.floor((kickoffMs - now) / 1000));
                                    
                                    // Display countdown if the round is in the future
                                    if (diffSec > 0 && diffSec <= 3600) { // Max 60 minutes in the future
                                        const mins = Math.floor(diffSec / 60);
                                        const secs = diffSec % 60;
                                        const timeText = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
                                        timers.push({ weekNum: row.round_number, timeText });
                                    }
                                }
                            } catch (dbErr) {
                                console.error("⚠️ Failed to load fallback timers from DB:", dbErr.message);
                            }
                        }

                        // Deduce the current active round as the minimum week number scraped or calculated
                        if (timers.length > 0) {
                            const scrapedWeeks = timers.map(t => t.weekNum);
                            const minActiveWeek = Math.min(...scrapedWeeks);
                            if (minActiveWeek >= 1 && minActiveWeek <= 38) {
                                if (activeRoundNum === null || minActiveWeek > activeRoundNum || (minActiveWeek === 1 && activeRoundNum >= 30)) {
                                    activeRoundNum = minActiveWeek;
                                }
                            }
                        }

                        for (const timer of timers) {
                            const { weekNum, timeText } = timer;
                            console.log(`[Timer Engine] Resolved timer for Week ${weekNum}: ${timeText}`);
                            
                            // Check if the timer is expired or expiring imminently (<= 10 seconds left)
                            let totalSeconds = 999;
                            if (timeText && timeText.includes(':')) {
                                const parts = timeText.split(':');
                                const minutes = parseInt(parts[0], 10) || 0;
                                const seconds = parseInt(parts[1], 10) || 0;
                                totalSeconds = minutes * 60 + seconds;
                            }

                            if (totalSeconds <= 10) {
                                // Note: We keep unplayed predictions in live_predictions so they can be scored and compared
                                // later when the user syncs results. getLivePredictions naturally filters them out
                                // from the "Upcoming" UI once they are expired.
                            }
                        }
                        
                        // Save timers to JSON file for frontend access
                        try {
                            const timersPath = `${dbPath}.timers.json`;
                            fs.writeFileSync(timersPath, JSON.stringify(timers));
                        } catch (writeErr) {
                            console.error("⚠️ Failed to write SportyBet timers JSON file:", writeErr.message);
                        }
                    } catch (timerErr) {
                        console.error("⚠️ Failed to scrape/process SportyBet week countdown timers:", timerErr.message);
                    }
                }

                // Periodically refresh data every 30 seconds
                if (Date.now() - lastClickTime > 30000) {
                    lastClickTime = Date.now();

                    if (directWs && directWs.isAlive()) {
                        console.log('[WS Direct] ⚡ Direct WS active. Nudging for background refresh...');
                        directWs.requestFixtures();
                        setTimeout(() => { if (directWs) directWs.requestResults(); }, 2000);
                    }

                    if (activeIframe) {
                        console.log("[Live Loop] Performing iframe click sequence to guarantee session activity and data updates...");
                        try {
                            const evalRes = await activeIframe.evaluate(async (leagueName, leagueId) => {
                                const delay = (ms) => new Promise(r => setTimeout(r, ms));
                                const triggerClick = (el) => {
                                    if (!el) return false;
                                    try {
                                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                        return true;
                                    } catch (err) {
                                        try { el.click(); return true; } catch (e) { return false; }
                                    }
                                };

                                // ── LEAGUE ACTIVE GUARD ──────────────────────────────────────────────────────
                                // Check if target league playlist is active via URL hash (Angular routing)
                                const targetHash = `#/scheduled/league/playlist/${leagueId}`;
                                const isHashActive = window.location.hash.includes(`playlist/${leagueId}`);

                                if (!isHashActive) {
                                    console.log(`[League Guard] Window hash (${window.location.hash}) does not match target league playlist. Navigating to ${targetHash}...`);
                                    window.location.hash = targetHash;
                                    await delay(3000);
                                }

                                const isLeagueActive = (() => {
                                    if (window.location.hash.includes(`playlist/${leagueId}`)) return true;

                                    // Strategy 1: playlist_<id> anchor with an active/selected class
                                    const byId = document.querySelector('#playlist_' + leagueId + ' a');
                                    if (byId) {
                                        const li = byId.closest('li');
                                        const cls = ((byId.className || '') + ' ' + (li ? li.className || '' : '')).toLowerCase();
                                        if (cls.includes('active') || cls.includes('selected') || cls.includes('current')) return true;
                                    }

                                    // Strategy 2: the league title link href contains the playlist id and is marked active
                                    const byHref = document.querySelector('a[href*="playlist/' + leagueId + '"]');
                                    if (byHref) {
                                        const li2 = byHref.closest('li');
                                        const cls2 = ((byHref.className || '') + ' ' + (li2 ? li2.className || '' : '')).toLowerCase();
                                        if (cls2.includes('active') || cls2.includes('selected') || cls2.includes('current')) return true;
                                    }

                                    // Strategy 3: check for week selector elements — if they exist, we are on a league page
                                    const hasWeeks = Array.from(document.querySelectorAll('*')).some(el => {
                                        if (el.children.length > 0 || el.offsetParent === null) return false;
                                        const t = el.textContent.trim();
                                        return t.startsWith('Week ') || t.startsWith('W ') || t.startsWith('Round ');
                                    });
                                    return hasWeeks;
                                })();

                                if (!isLeagueActive) {
                                    console.log('[League Guard] Target league "' + leagueName + '" is NOT active. Re-selecting via DOM...');

                                    // Step A: expand the Football League accordion if needed
                                    const getTogglerSelector = () => {
                                        const toggler = document.querySelector('#game_league > a') ||
                                                        document.querySelector('a.toggler[title="Football League"]') ||
                                                        document.querySelector('a.toggler.gr-icon-league') ||
                                                        document.querySelector('#game_league') ||
                                                        document.querySelector('[title*="Football League"]') ||
                                                        document.querySelector('.gr-icon-league');
                                        if (toggler && toggler.offsetParent !== null) return toggler;

                                        const allElements = Array.from(document.querySelectorAll('a, button, div, span, li'));
                                        const textMatch = allElements.find(el => {
                                            if (el.offsetParent === null) return false;
                                            const elText = el.textContent.toLowerCase().trim();
                                            if (elText.includes('football league')) {
                                                const children = Array.from(el.children);
                                                const childMatches = children.some(child => child.offsetParent !== null && child.textContent.toLowerCase().includes('football league'));
                                                return !childMatches;
                                            }
                                            return false;
                                        });
                                        if (textMatch) return textMatch;
                                        if (toggler) return toggler;

                                        const anyTextMatch = allElements.find(el => {
                                            const elText = el.textContent.toLowerCase().trim();
                                            if (elText.includes('football league')) {
                                                const children = Array.from(el.children);
                                                const childMatches = children.some(child => child.textContent.toLowerCase().includes('football league'));
                                                return !childMatches;
                                            }
                                            return false;
                                        });
                                        return anyTextMatch || null;
                                    };

                                    const toggler = getTogglerSelector();
                                    if (toggler && (toggler.classList.contains('collapsed') || (toggler.className || '').toString().includes('collapsed'))) {
                                        triggerClick(toggler);
                                        await delay(2000);
                                    }

                                     // Step B: click the target league link
                                     const getLeagueSelector = () => {
                                         const playlistEl = document.querySelector('#playlist_' + leagueId + ' > a') ||
                                                            document.querySelector('#playlist_' + leagueId + ' a') ||
                                                            document.querySelector('a[href*="playlist/' + leagueId + '"]') ||
                                                            document.querySelector('a[href*="' + leagueId + '"]');
                                         if (playlistEl && playlistEl.offsetParent !== null) {
                                             return playlistEl;
                                         }
                                         const isSidebarElement = (el) => {
                                             if (!el) return false;
                                             return el.closest('#game_league') || 
                                                    el.closest('[id*="playlist"]') || 
                                                    el.closest('.sidebar') || 
                                                    el.closest('.menu') || 
                                                    el.closest('.navigation') || 
                                                    el.closest('.playlist') ||
                                                    el.closest('.playlist-container');
                                         };
                                         const candidates = Array.from(document.querySelectorAll('a[title*="' + leagueName + '"]')).filter(isSidebarElement);
                                         for (const el of candidates) {
                                             if (el.offsetParent !== null) {
                                                 return el;
                                             }
                                         }
                                         const searchNames = [leagueName.toLowerCase()];
                                         if (leagueName.toLowerCase() === 'england') searchNames.push('english');
                                         if (leagueName.toLowerCase() === 'english') searchNames.push('england');
                                         const allElements = Array.from(document.querySelectorAll('a, button, li')).filter(isSidebarElement);
                                         const textMatch = allElements.find(el => {
                                             if (el.offsetParent === null) return false;
                                             const elText = el.textContent.toLowerCase().trim();
                                             return searchNames.some(name => {
                                                 if (elText === name || elText.includes(name)) {
                                                     const children = Array.from(el.children);
                                                     const childMatches = children.some(child => child.offsetParent !== null && child.textContent.toLowerCase().includes(name));
                                                     return !childMatches;
                                                 }
                                                 return false;
                                             });
                                         });
                                         if (textMatch) return textMatch;
                                         if (playlistEl) return playlistEl;
                                         return null;
                                     };

                                     const leagueEl = getLeagueSelector();
                                     if (leagueEl) {
                                         console.log('[League Guard] Clicking league link for "' + leagueName + '"...');
                                         triggerClick(leagueEl);
                                         await delay(4000); // Allow league page + WebSocket payloads to load
                                     } else {
                                         console.log('[League Guard] League link not found in DOM. Will retry next tick.');
                                     }
                                } else {
                                    console.log('[League Guard] League "' + leagueName + '" is active ✓');
                                }
                                // ── END LEAGUE ACTIVE GUARD ──────────────────────────────────────────────────

                                const weekElements = Array.from(document.querySelectorAll('*')).filter(el => {
                                    if (el.children.length > 0) return false;
                                    const text = el.textContent.trim();
                                    const isNum = /^\d+$/.test(text);
                                    if (isNum) {
                                        const val = parseInt(text, 10);
                                        if (val >= 1 && val <= 38) {
                                            let parent = el.parentElement;
                                            let depth = 0;
                                            while (parent && depth < 4) {
                                                const parentText = parent.textContent.toLowerCase();
                                                const parentClass = (parent.className || '').toString().toLowerCase();
                                                const hasContext = parentText.includes('week') || 
                                                                   parentText.includes('matchday') || 
                                                                   parentText.includes('round') || 
                                                                   parentClass.includes('scheduler') || 
                                                                   parentClass.includes('nav') ||
                                                                   parentClass.includes('tabs') ||
                                                                   parentClass.includes('menu');
                                                if (hasContext) return true;
                                                parent = parent.parentElement;
                                                depth++;
                                            }
                                        }
                                    }
                                    return text.startsWith('Week ') || text.startsWith('W ') || text.startsWith('Round ');
                                });

                                for (const el of weekElements) {
                                    try {
                                        triggerClick(el);
                                        await delay(300);
                                    } catch (clickErr) {}
                                }
                                
                                // Try to click the right scroll arrow
                                const rightArrow = Array.from(document.querySelectorAll('*')).find(el => {
                                    const classStr = (el.className || '').toString().toLowerCase();
                                    return classStr.includes('icon-arrow-right') || classStr.includes('nav-next') || classStr.includes('scroll-right') || el.getAttribute('aria-label') === 'Next';
                                });
                                
                                if (rightArrow && rightArrow.offsetParent !== null) {
                                    triggerClick(rightArrow);
                                    await delay(500);
                                    
                                    const moreWeekElements = Array.from(document.querySelectorAll('*')).filter(el => {
                                        if (el.children.length > 0) return false;
                                        const text = el.textContent.trim();
                                        return text.startsWith('Week ') || text.startsWith('W ') || text.startsWith('Round ');
                                    });
                                    const newWeeks = moreWeekElements.filter(nw => !weekElements.includes(nw));
                                    for (const el of newWeeks) {
                                        try { triggerClick(el); await delay(300); } catch(e){}
                                    }
                                }

                                 // Step C: Trigger Results tab click and extract completed match results directly from Golden Race DOM
                                 const domScrapedResults = [];
                                 try {
                                     const resultsTab = document.querySelector('#game_league_results-history > a') ||
                                                      Array.from(document.querySelectorAll('a[title*="Results"]')).find(el => el.offsetParent !== null) ||
                                                      Array.from(document.querySelectorAll('*')).find(el => {
                                                          if (el.children.length > 0 || el.offsetParent === null) return false;
                                                          const text = el.textContent.trim().toLowerCase();
                                                          return text === 'results history' || text === 'results' || text === 'history';
                                                      });
                                     if (resultsTab) {
                                         triggerClick(resultsTab);
                                         await delay(2000); // Allow Golden Race time to stream and render panels
                                     }

                                     // Extract visible results from history-container
                                     const panels = Array.from(document.querySelectorAll('.history-container .panel'));
                                     for (const p of panels) {
                                         const heading = p.querySelector('.panel-heading')?.innerText?.replace(/\s+/g, ' ').trim() || '';
                                         const matchBlocks = Array.from(p.querySelectorAll('.football-event-block'));
                                         for (const b of matchBlocks) {
                                             const teamA = b.querySelector('.teamA .participant-text-name')?.innerText?.trim();
                                             const teamB = b.querySelector('.teamB .participant-text-name')?.innerText?.trim();
                                             const score = b.querySelector('.match-result-score')?.innerText?.trim();
                                             if (teamA && teamB && score && score.includes(':')) {
                                                 domScrapedResults.push({ teamA, teamB, score, heading });
                                             }
                                         }
                                     }

                                     // Re-click the first week or league to return to active matches view
                                     if (resultsTab && weekElements.length > 0) {
                                         triggerClick(weekElements[0]);
                                     }
                                 } catch (_) {}

                                 return { domScrapedResults };
                            }, targetLeagueName, targetLeagueId);

                            if (evalRes && evalRes.domScrapedResults && evalRes.domScrapedResults.length > 0) {
                                let domScoredCount = 0;
                                for (const dr of evalRes.domScrapedResults) {
                                    const hTeam = formatTeamName(dr.teamA);
                                    const aTeam = formatTeamName(dr.teamB);
                                    const [hScore, aScore] = dr.score.split(':').map(s => parseInt(s.trim(), 10));
                                    if (!isNaN(hScore) && !isNaN(aScore)) {
                                        let timeMs = null;
                                        const timeMatch = dr.heading ? dr.heading.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/) : null;
                                        if (timeMatch) {
                                            const parts = timeMatch[1].split(' ');
                                            const [d, m, y] = parts[0].split('/').map(Number);
                                            const [hh, mm] = parts[1].split(':').map(Number);
                                            timeMs = Date.UTC(y, m - 1, d, hh, mm);
                                        }
                                        processResultNow({
                                            homeTeam: hTeam,
                                            awayTeam: aTeam,
                                            homeScore: hScore,
                                            awayScore: aScore,
                                            htHome: 0,
                                            htAway: 0,
                                            eventTime: timeMs
                                        });
                                        domScoredCount++;
                                    }
                                }
                                if (domScoredCount > 0) {
                                    console.log(`[DOM Scraper] Checked and processed ${domScoredCount} results directly from Golden Race history DOM.`);
                                }
                            }

                            console.log("[Stealth Scraper] Simulating human keypress navigation (ArrowLeft/ArrowDown/ArrowUp) in refresh loop...");
                            try {
                                const iframeElement = await page.$(SPORTY_IFRAME_SELECTOR);
                                if (iframeElement) {
                                    await iframeElement.focus();
                                    await delay(500);

                                    for (let i = 0; i < 4; i++) {
                                        await page.keyboard.press('ArrowLeft');
                                        await delay(100 + Math.random() * 50);
                                    }
                                    await delay(500);

                                    for (let i = 0; i < 45; i++) {
                                        await page.keyboard.press('ArrowDown');
                                        await delay(50 + Math.random() * 30);
                                    }
                                    await delay(500);

                                    for (let i = 0; i < 45; i++) {
                                        await page.keyboard.press('ArrowUp');
                                        await delay(50 + Math.random() * 30);
                                    }
                                    await delay(500);
                                }
                            } catch (navErr) {
                                console.warn("⚠️ Warning during stealth navigation keypresses in refresh loop:", navErr.message);
                            }
                        } catch (evalErr) {
                            console.error("⚠️ Error while re-triggering week selectors in iframe:", evalErr.message);
                        }
                    }
                }

                // Wait up to 15 seconds for WebSocket streams to populate upcomingMatchesScraped if empty
                if (upcomingMatchesScraped.length === 0 && resultsScraped.length === 0) {
                    console.log("[Live Loop] Waiting for live WebSocket streams to receive upcoming events...");
                    for (let w = 0; w < 15; w++) {
                        await delay(1000);
                        if (upcomingMatchesScraped.length > 0 || resultsScraped.length > 0) break;
                    }
                }

                // Copy and clear the scraped queues
                const upcomingToProcess = [...upcomingMatchesScraped];
                upcomingMatchesScraped = [];
                
                const resultsToProcess = [...resultsScraped];
                resultsScraped = [];

                if (upcomingToProcess.length > 0 || resultsToProcess.length > 0) {
                    lastSuccessfulDataTime = Date.now();
                    consecutive401Count = 0;
                    console.log(`[Live Loop] Processing ${upcomingToProcess.length} upcoming events and ${resultsToProcess.length} results...`);
                    
                    // Check if round reset to early season, if so, archive old season (cleanup live_predictions)
                    if (activeRoundNum <= 5) {
                        const maxRoundRow = db.prepare("SELECT MAX(round_number) as max_r FROM live_predictions WHERE season_name = ?").get(activeSeasonName);
                        if (maxRoundRow && maxRoundRow.max_r >= 38) {
                            console.log("🧹 New Sportybet season detected. Archiving old live predictions...");
                            const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ? AND scored_status = 1").all(activeSeasonName);
                            const insertFixture = db.prepare(`
                                INSERT OR IGNORE INTO sporty_fixtures (
                                    league_name, season_name, match_time, home_team, away_team,
                                    ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `);
                            for (const m of completedMatches) {
                                if (m.actual_score) {
                                    const scores = m.actual_score.split(':').map(Number);
                                    const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                                    const dateStr = new Date().toISOString().slice(0,10);
                                    insertFixture.run(leagueName, `Season ${dateStr}`, m.match_time, m.home_team, m.away_team, htScores[0], htScores[1], scores[0], scores[1], m.bookmaker_odds);
                                }
                            }
                            db.prepare("DELETE FROM live_predictions WHERE season_name = ?").run(activeSeasonName);

                            try {
                                console.log("📈 Re-optimizing ML blending weights and decay rate with newly archived season data...");
                                const optResult = optimizeBlendingWeights(dbPath, 'sportybet');
                                console.log(`📊 ML Optimization completed: Poisson Weight: ${optResult.poissonWeight}, Elo Weight: ${optResult.eloWeight}, Decay Rate: ${optResult.decayRate}, Brier Score: ${optResult.brierScore}`);
                            } catch (optErr) {
                                console.error("⚠️ Failed to optimize blending weights:", optErr.message);
                            }
                        }
                    }

                    // Process Results
                    for (const res of resultsToProcess) {
                        const { homeTeam, awayTeam, htHome, htAway, homeScore, awayScore, eventTime } = res;
                        if (!homeTeam || !awayTeam || homeScore == null) continue;
                        
                        const resultTimeMs = eventTime ? (isNaN(Number(eventTime)) ? new Date(eventTime).getTime() : Number(eventTime)) : null;
                        const actualScoreStr = `${homeScore}:${awayScore}`;
                        const actualHtScoreStr = `${htHome != null ? htHome : 0}:${htAway != null ? htAway : 0}`;

                        const existingList = db.prepare(`
                            SELECT id, scored_status, kickoff_timestamp, season_name FROM live_predictions 
                            WHERE home_team = ? AND away_team = ? AND scored_status = 0
                            ORDER BY id DESC
                        `).all(homeTeam, awayTeam);

                        let matchedLive = existingList.find(pred => {
                            // Do not score a match whose kickoff is in the future
                            if (pred.kickoff_timestamp && pred.kickoff_timestamp > Date.now() + 15 * 1000) {
                                return false;
                            }
                            if (!resultTimeMs) return true;
                            return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                        }) || (existingList.length > 0 && (!existingList[0].kickoff_timestamp || existingList[0].kickoff_timestamp <= Date.now() + 15 * 1000) ? existingList[0] : null);

                        if (matchedLive) {
                            const oddsJson = res.odds ? JSON.stringify(res.odds) : null;
                            db.prepare(`
                                UPDATE live_predictions
                                SET actual_score = ?, actual_ht_score = ?, scored_status = 1, bookmaker_odds = COALESCE(bookmaker_odds, ?)
                                WHERE id = ?
                            `).run(actualScoreStr, actualHtScoreStr, oddsJson, matchedLive.id);
                            predictionsScored++;
                        }

                        // Score historical_market_predictions (regardless of whether live_predictions had a row)
                        const historicalList = db.prepare(`
                            SELECT id, kickoff_timestamp 
                            FROM historical_market_predictions 
                            WHERE provider = 'sportybet' AND home_team = ? AND away_team = ? AND actual_score IS NULL
                            ORDER BY id DESC
                        `).all(homeTeam, awayTeam);

                        const targetHist = historicalList.find(pred => {
                            if (pred.kickoff_timestamp && pred.kickoff_timestamp > Date.now() + 15 * 1000) return false;
                            if (!resultTimeMs) return true;
                            return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                        }) || (historicalList.length > 0 && (!historicalList[0].kickoff_timestamp || historicalList[0].kickoff_timestamp <= Date.now() + 15 * 1000) ? historicalList[0] : null);

                        if (targetHist) {
                            db.prepare(`UPDATE historical_market_predictions SET actual_score = ?, actual_ht_score = ? WHERE id = ?`)
                                .run(actualScoreStr, actualHtScoreStr, targetHist.id);
                        }

                        // Direct settlement of matching AI picks
                        try {
                            const pendingPicks = db.prepare(`
                                SELECT id, market, kickoff_timestamp 
                                FROM ai_best_picks_history 
                                WHERE home_team = ? AND away_team = ? AND status = 'pending'
                                ORDER BY id DESC
                            `).all(homeTeam, awayTeam);

                            for (const pick of pendingPicks) {
                                const isMatch = !resultTimeMs || !pick.kickoff_timestamp || isSameDateTime(resultTimeMs, pick.kickoff_timestamp);
                                if (isMatch) {
                                    const finalStatus = typeof evaluatePickOutcome === 'function' ? evaluatePickOutcome(pick.market, actualScoreStr, actualHtScoreStr) : null;
                                    if (finalStatus) {
                                        db.prepare(`UPDATE ai_best_picks_history SET actual_score = ?, status = ? WHERE id = ?`)
                                            .run(actualScoreStr, finalStatus, pick.id);
                                        try {
                                            settlementLogger.settled({
                                                id: pick.id,
                                                home_team: homeTeam,
                                                away_team: awayTeam,
                                                market: pick.market,
                                                actual_score: actualScoreStr,
                                                actual_ht_score: actualHtScoreStr,
                                                status: finalStatus,
                                                season_name: pick.season_name,
                                                round_number: pick.round_number
                                            });
                                        } catch (_) {}
                                    }
                                }
                            }
                        } catch (_) {}
                    }

                    // Prepare combined training data (historical + current season's completed matches)
                    let combinedTrainingSet = [];
                    if (upcomingToProcess.length > 0) {
                        const historicalMatches = db.prepare(
                            "SELECT id, home_team, away_team, home_score, away_score, ht_home_score, ht_away_score FROM betting_analytics WHERE league_name = ? ORDER BY id ASC"
                        ).all(leagueName);

                        const liveCompleted = db.prepare(`
                            SELECT home_team, away_team, actual_score, actual_ht_score, match_time
                            FROM live_predictions
                            WHERE season_name LIKE 'Sportybet%' AND scored_status = 1
                            ORDER BY id ASC
                        `).all();

                        const liveRows = [];
                        for (const m of liveCompleted) {
                            if (m.actual_score) {
                                const scores = m.actual_score.split(':').map(Number);
                                const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                                liveRows.push({
                                    home_team: m.home_team,
                                    away_team: m.away_team,
                                    home_score: scores[0],
                                    away_score: scores[1],
                                    ht_home_score: htScores[0],
                                    ht_away_score: htScores[1],
                                    match_time: m.match_time || ''
                                });
                            }
                        }
                        combinedTrainingSet = [...historicalMatches, ...liveRows];
                    }

                    createdSeasons.clear();
                    // Process Upcoming Matches
                    for (const match of upcomingToProcess) {
                        const { homeTeam, awayTeam, matchDay, eventTime } = match;
                        
                        // Skip if the kickoff time is in the past by more than 3 minutes (already played)
                        // Using 3 min grace window to avoid dropping events when the loop was briefly slow
                        if (eventTime && Number(eventTime) < Date.now() - 3 * 60 * 1000) {
                            continue;
                        }

                        const seasonName = getSportySeasonName(leagueName, matchDay, eventTime);

                        const existing = db.prepare(`
                            SELECT id FROM live_predictions 
                            WHERE season_name = ? AND home_team = ? AND away_team = ? AND round_number = ?
                        `).get(seasonName, homeTeam, awayTeam, matchDay);

                        if (!existing) {
                            // Calculate kickoff hour and time-of-day goal factor
                            let kickoffHour = null;
                            if (eventTime) {
                                try {
                                    const hourStr = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date(eventTime));
                                    kickoffHour = parseInt(hourStr, 10);
                                } catch (e) {}
                            }

                            let timeGoalsFactor = 1.0;
                            if (kickoffHour !== null) {
                                try {
                                    const timeAdj = getTimeAdjustmentFactor(dbPath, kickoffHour, true);
                                    if (timeAdj && timeAdj.factor) {
                                        timeGoalsFactor = timeAdj.factor;
                                    }
                                } catch (e) {}
                            }

                            const pred = predictFromRows(combinedTrainingSet, homeTeam, awayTeam, decayRate, { poissonWeight, poissonWeightDraw, poissonWeightWin }, timeGoalsFactor);
                            if (pred) {
                                let predicted = 'Draw';
                                if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb) predicted = 'Home';
                                else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb) predicted = 'Away';

                                const probs = {
                                    homeWinProb:  Math.round(pred.homeWinProb * 100),
                                    drawProb:     Math.round(pred.drawProb    * 100),
                                    awayWinProb:  Math.round(pred.awayWinProb * 100),
                                    ggProb:       Math.round(pred.gg          * 100),
                                    over15Prob:   Math.round(pred.over15      * 100),
                                    over25Prob:   Math.round(pred.over25      * 100),
                                    over35Prob:   Math.round(pred.over35      * 100),
                                    over45Prob:   Math.round(pred.over45      * 100),
                                    over55Prob:   Math.round(pred.over55      * 100),
                                    htOver25Prob: Math.round(pred.htOver25    * 100),
                                    htOver35Prob: Math.round(pred.htOver35    * 100),
                                    oddProb:      Math.round(pred.odd         * 100),
                                    evenProb:     Math.round(pred.even        * 100),
                                    dnbHomeProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.home : 0.5) * 100),
                                    dnbAwayProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.away : 0.5) * 100),
                                    htScoring1stProb: Math.round(pred.htScoring1st * 100),
                                    htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
                                    htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
                                    htft11Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft11 : 0) * 100),
                                    htft1XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft1X : 0) * 100),
                                    htft12Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft12 : 0) * 100),
                                    htftX1Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX1 : 0) * 100),
                                    htftXXProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftXX : 0) * 100),
                                    htftX2Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX2 : 0) * 100),
                                    htft21Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft21 : 0) * 100),
                                    htft2XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft2X : 0) * 100),
                                    htft22Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft22 : 0) * 100)
                                };

                                const kickoffMs = eventTime ? (isNaN(Number(eventTime)) ? new Date(eventTime).getTime() : Number(eventTime)) : Date.now();
                                const matchTimeStr = new Date(kickoffMs).toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit', timeZone: 'Africa/Lagos'});

                                insertPred.run(
                                    seasonName, matchDay, matchTimeStr, homeTeam, awayTeam,
                                    predicted, JSON.stringify(probs), pred.aiReasoning || '', pred.anomalyDetected ? 1 : 0, kickoffMs, targetLeagueId,
                                    match.odds ? JSON.stringify(match.odds) : null
                                );
                                insertHistoricalPred.run(
                                    seasonName, matchDay, matchTimeStr, homeTeam, awayTeam,
                                    JSON.stringify(probs), kickoffMs
                                );
                                predictionsCreated++;
                                createdSeasons.add(seasonName);
                            }
                        }
                    }

                    console.log(`[Live Loop] Processed results & predictions: created ${predictionsCreated}, scored ${predictionsScored}`);
                    
                    // Settle any pending AI picks
                    try {
                        settlePendingAIPicks(db);
                    } catch (settleErr) {
                        console.error(`   ⚠️ Failed to settle pending AI picks:`, settleErr.message);
                    }

                    // Enqueue newly created seasons for AI picks generation (highest priority: unshift to front)
                    for (const seasonName of createdSeasons) {
                        if (!backfilledSeasons.has(seasonName) && !aiPicksQueue.includes(seasonName)) {
                            aiPicksQueue.unshift(seasonName);
                        }
                    }

                    // Enqueue existing seasons missing AI picks ONLY when queue is empty
                    if (aiPicksQueue.length === 0) {
                        try {
                            const seasonsNeedingPicks = db.prepare(`
                                SELECT DISTINCT lp.season_name
                                FROM live_predictions lp
                                WHERE lp.season_name LIKE 'Sportybet%'
                                AND lp.round_number IS NOT NULL
                                AND lp.kickoff_timestamp > ?
                                AND NOT EXISTS (
                                    SELECT 1 FROM ai_best_picks_history abph
                                    WHERE abph.season_name = lp.season_name AND abph.round_number = lp.round_number
                                )
                                ORDER BY lp.id DESC
                                LIMIT 2
                            `).all(Date.now() + 60 * 1000).map(r => r.season_name).filter(s => !backfilledSeasons.has(s) && !aiPicksQueue.includes(s));

                            for (const seasonName of seasonsNeedingPicks) {
                                backfilledSeasons.add(seasonName); // prevent re-discovery
                                aiPicksQueue.push(seasonName);
                                console.log(`[Live Loop] Queued AI picks backfill for: ${seasonName}`);
                            }
                        } catch (backfillErr) {
                            console.error(`   ⚠️ Error during picks backfill discovery:`, backfillErr.message);
                        }
                    }

                    // Process ONE season from the AI picks queue per loop tick with strict 15s timeout
                    if (aiPicksQueue.length > 0) {
                        const seasonName = aiPicksQueue.shift();
                        console.log(`[Live Loop] Processing AI picks queue (${aiPicksQueue.length} remaining): ${seasonName}`);
                        try {
                            await Promise.race([
                                updateAIPicksHistory(db, seasonName, dbPath),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('AI picks calculation timed out (15s)')), 15000))
                            ]);
                        } catch (e) {
                            console.error(`   ⚠️ Failed to update AI picks for ${seasonName}:`, e.message);
                        }
                    }

                    // Automatically broadcast newly generated predictions / AI picks and settled results to Telegram
                    try {
                        const { broadcastPendingPredictions, broadcastSettledResults } = require('./telegram_broadcaster');
                        await broadcastPendingPredictions(db);
                        await broadcastSettledResults(db);
                    } catch (tgErr) {
                        console.warn(`   ⚠️ Telegram auto-broadcast notice:`, tgErr.message);
                    }

                    // Automatically live-sync updated databases to Google Drive if configured
                    try {
                        const { syncDatabasesToGoogleDrive } = require('./google_sync_helper');
                        syncDatabasesToGoogleDrive();
                    } catch (_) {}

                    // Automatically check and trigger background AI model retraining if new results have settled
                    try {
                        const { triggerAutoTrainingIfDue } = require('./auto_trainer');
                        triggerAutoTrainingIfDue(dbPath, { minNewMatches: 20, intervalMinutes: 60 });
                    } catch (_) {}
                } else {
                    // Even if no new upcoming/results buffer, ensure pending picks are settled & broadcasted
                    try {
                        settlePendingAIPicks(db);
                        const { broadcastPendingPredictions, broadcastSettledResults } = require('./telegram_broadcaster');
                        await broadcastPendingPredictions(db);
                        await broadcastSettledResults(db);
                    } catch (_) {}

                    // Check background AI model retraining
                    try {
                        const { triggerAutoTrainingIfDue } = require('./auto_trainer');
                        triggerAutoTrainingIfDue(dbPath, { minNewMatches: 20, intervalMinutes: 60 });
                    } catch (_) {}
                }
            } catch (loopErr) {
                console.error("⚠️ Error in live companion loop tick:", loopErr);
            }

            if (!isContinuous) {
                console.log("[Live Loop] Single-tick mode. Exiting loop...");
                break;
            }

            // Sleep 5 seconds
            await delay(5000);
        }

        // Tear down direct WS and CDP capture listener
        if (cleanupWsCapture) cleanupWsCapture();
        if (directWs) { directWs.destroy(); directWs = null; }

        if (browser) await browser.close();
        db.close();

        // Final sync after closing database connection
        try {
            const { syncDatabasesToGoogleDrive } = require('./google_sync_helper');
            syncDatabasesToGoogleDrive();
        } catch (_) {}

        const finalSeasonName = createdSeasons.size > 0 ? Array.from(createdSeasons)[createdSeasons.size - 1] : `${leagueName} Live`;

        return {
            success: true,
            seasonName: finalSeasonName,
            eventTime: eventTime,
            predictionsCreated,
            predictionsScored
        };

    } catch (e) {
        if (cleanupWsCapture) cleanupWsCapture();
        if (directWs) { try { directWs.destroy(); } catch(_) {} }
        if (browser) await browser.close();
        db.close();
        console.error("❌ Sportybet live companion failed:", e);
        return { success: false, error: e.message };
    }
}


async function scrapeHistoricalResultsSync(dbPath, targetLeagueId = 41104) {
    const Database = require('better-sqlite3');
    let db = null;
    const PLAYLIST_LEAGUE_MAP = {
        41104: "Sportybet England",
        41110: "Sportybet Italy",
        41108: "Sportybet Germany",
        41113: "Sportybet Spain",
        41106: "Sportybet France",
        41114: "Sportybet Turkey"
    };
    const leagueName = PLAYLIST_LEAGUE_MAP[targetLeagueId] || "Sportybet England";
    const activeSeasonName = `${leagueName} Live`;

    let page, browser;
    let resultsScraped = [];
    try {
        db = new Database(dbPath);
        try {
            console.log("[Historical Sync] Launching stealth browser for Sportybet...");
        const result = await config.connect({ headless: true, provider: 'sportybet', profile: 'Temporary' });
        page = result;
        if (page.browser) browser = page.browser();
        await page.setViewport({ width: 966, height: 714 });

        page.on('console', msg => {
            const txt = msg.text();
            if (txt.includes('[Stealth Scraper]')) console.log(txt);
        });

        const mainSession = await page.target().createCDPSession();
        await mainSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

        mainSession.on('Target.attachedToTarget', async ({ sessionId }) => {
            const childSession = mainSession.connection().session(sessionId);
            if (!childSession) return;
            try {
                await childSession.send('Network.enable');
                childSession.on('Network.webSocketFrameReceived', ({ response }) => {
                    try {
                        const payload = response.payloadData;
                        if (!payload || !payload.startsWith('{')) return;
                        const parsed = JSON.parse(payload);
                        if (parsed.type !== 'RESPONSE' || !parsed.res || parsed.res.statusCode !== 200) return;
                        
                        const resource = parsed.res.resource;
                        const blocks = parsed.res.body;
                        if (!Array.isArray(blocks)) return;

                        if (resource === '/eventBlocks/event/result') {
                            for (const block of blocks) {
                                if (!block.events || block.playlistId !== targetLeagueId) continue;
                                for (const event of block.events) {
                                    if (!event.data || !event.data.participants || event.data.participants.length < 2) continue;
                                    if (!event.result || !event.result.finalOutcome) continue;
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

                                    resultsScraped.push({
                                        homeTeam: formatTeamName(event.data.participants[0].fifaCode, event.data.participants[0].name),
                                        awayTeam: formatTeamName(event.data.participants[1].fifaCode, event.data.participants[1].name),
                                        htHome: parseInt(scores[0], 10),
                                        htAway: parseInt(scores[1], 10),
                                        homeScore: parseInt(scores[0], 10) + parseInt(scores[2], 10),
                                        awayScore: parseInt(scores[1], 10) + parseInt(scores[3], 10),
                                        eventTime: block.eventTime,
                                        odds: parsedOdds
                                    });
                                }
                            }
                        }
                    } catch (e) {}
                });
            } catch (e) {}
        });

        console.log("[Historical Sync] Navigating to Sportybet Virtuals...");
        await page.goto('https://www.sportybet.com/ng/virtual/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(12000);

        let iframe = null;
        let attempts = 0;
        while (!iframe && attempts < 15) {
            iframe = await resolveSportyIframe(page);
            if (!iframe) await delay(2000);
            attempts++;
        }

        if (iframe) {
            console.log(`[Historical Sync] Found iframe. Clicking league "${leagueName}" then Results tab...`);
            const clicked = await iframe.evaluate(async (leagueId, leagueName) => {
                const delay = (ms) => new Promise(r => setTimeout(r, ms));
                const triggerClick = (el) => {
                    if (!el) return;
                    try {
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    } catch(e) { el.click(); }
                };

                const getTogglerSelector = () => {
                    const toggler = document.querySelector('#game_league > a') ||
                                    document.querySelector('a.toggler[title="Football League"]') ||
                                    document.querySelector('a.toggler.gr-icon-league') ||
                                    document.querySelector('#game_league') ||
                                    document.querySelector('[title*="Football League"]') ||
                                    document.querySelector('.gr-icon-league');
                    if (toggler && toggler.offsetParent !== null) return toggler;

                    // Fallback to text search
                    const allElements = Array.from(document.querySelectorAll('a, button, div, span, li'));
                    const textMatch = allElements.find(el => {
                        if (el.offsetParent === null) return false;
                        const elText = el.textContent.toLowerCase().trim();
                        if (elText.includes('football league')) {
                            const children = Array.from(el.children);
                            const childMatches = children.some(child => child.offsetParent !== null && child.textContent.toLowerCase().includes('football league'));
                            return !childMatches;
                        }
                        return false;
                    });
                    if (textMatch) return textMatch;
                    if (toggler) return toggler;

                    // Absolute fallback ignoring offsetParent
                    const anyTextMatch = allElements.find(el => {
                        const elText = el.textContent.toLowerCase().trim();
                        if (elText.includes('football league')) {
                            const children = Array.from(el.children);
                            const childMatches = children.some(child => child.textContent.toLowerCase().includes('football league'));
                            return !childMatches;
                        }
                        return false;
                    });
                    return anyTextMatch || null;
                };

                const getLeagueSelector = () => {
                    const playlistEl = document.querySelector('#playlist_' + leagueId + ' > a') ||
                                       document.querySelector('#playlist_' + leagueId + ' a') ||
                                       document.querySelector('a[href*="playlist/' + leagueId + '"]') ||
                                       document.querySelector('a[href*="' + leagueId + '"]');
                    if (playlistEl && playlistEl.offsetParent !== null) {
                        return playlistEl;
                    }
                    const isSidebarElement = (el) => {
                        if (!el) return false;
                        return el.closest('#game_league') || 
                               el.closest('[id*="playlist"]') || 
                               el.closest('.sidebar') || 
                               el.closest('.menu') || 
                               el.closest('.navigation') || 
                               el.closest('.playlist') ||
                               el.closest('.playlist-container');
                    };
                    const candidates = Array.from(document.querySelectorAll('a[title*="' + leagueName + '"]')).filter(isSidebarElement);
                    for (const el of candidates) {
                        if (el.offsetParent !== null) {
                            return el;
                        }
                    }
                    const searchNames = [leagueName.toLowerCase()];
                    if (leagueName.toLowerCase() === 'england') searchNames.push('english');
                    if (leagueName.toLowerCase() === 'english') searchNames.push('england');
                    const allElements = Array.from(document.querySelectorAll('a, button, li')).filter(isSidebarElement);
                    const textMatch = allElements.find(el => {
                        if (el.offsetParent === null) return false;
                        const elText = el.textContent.toLowerCase().trim();
                        return searchNames.some(name => {
                            if (elText === name || elText.includes(name)) {
                                const children = Array.from(el.children);
                                const childMatches = children.some(child => child.offsetParent !== null && child.textContent.toLowerCase().includes(name));
                                return !childMatches;
                            }
                            return false;
                        });
                    });
                    if (textMatch) return textMatch;
                    if (playlistEl) return playlistEl;
                    return null;
                };

                // Step 1: Click the league in the sidebar
                let leagueEl = getLeagueSelector();
                if (!leagueEl) {
                    const toggler = getTogglerSelector();
                    if (toggler && (toggler.classList.contains('collapsed') || (toggler.className || '').toString().includes('collapsed'))) {
                        triggerClick(toggler);
                        await delay(2000); // wait for animation
                        leagueEl = getLeagueSelector();
                    }
                }

                if (leagueEl) {
                    triggerClick(leagueEl);
                    await delay(3000); // wait 3s for league page to load
                }
                
                // Step 2: Poll for the Results tab to appear (up to 10 seconds, using exact selector #game_league_results-history > a first)
                let resultsTab = null;
                for (let i = 0; i < 20; i++) {
                    resultsTab = document.querySelector('#game_league_results-history > a') ||
                                 Array.from(document.querySelectorAll('a[title="Results History"]')).find(el => el.offsetParent !== null) ||
                                 Array.from(document.querySelectorAll('*')).find(el => {
                                     if (el.children.length > 0 || el.offsetParent === null) return false;
                                     const text = el.textContent.trim().toLowerCase();
                                     return text === 'results history' || text === 'results' || text === 'history';
                                 });
                    if (resultsTab) break;
                    await delay(500);
                }
                
                if (resultsTab) {
                    triggerClick(resultsTab);
                    return true;
                }
                return false;
            }, targetLeagueId, leagueName);
            
            if (clicked) {
                console.log("[Historical Sync] Results tab clicked. Waiting for WebSocket payloads to stream in...");
                // Poll for incoming results (up to 15 seconds)
                let waitAttempts = 0;
                while (resultsScraped.length === 0 && waitAttempts < 30) {
                    await delay(500);
                    waitAttempts++;
                }
                if (resultsScraped.length > 0) {
                    // Let other packets stream in
                    await delay(2000);
                }
            } else {
                console.warn("[Historical Sync] Could not find Results tab in iframe.");
            }
        }
        } catch (browserErr) {
            console.error("[Historical Sync] Browser or scraping error:", browserErr.message);
        }

        let updatedHistorical = 0;
        let updatedLive = 0;

        if (resultsScraped.length > 0) {
            console.log(`[Historical Sync] Scraped ${resultsScraped.length} past results. Updating database...`);
            
            db.transaction(() => {
                for (const res of resultsScraped) {
                    const actualScore = `${res.homeScore}:${res.awayScore}`;
                    const actualHtScore = `${res.htHome}:${res.htAway}`;
                    
                    const resultTimeMs = res.eventTime ? (isNaN(Number(res.eventTime)) ? new Date(res.eventTime).getTime() : Number(res.eventTime)) : null;

                    // Match live prediction
                    const liveList = db.prepare(`
                        SELECT id, kickoff_timestamp 
                        FROM live_predictions
                        WHERE season_name LIKE ? AND home_team = ? AND away_team = ? AND scored_status = 0
                    `).all(leagueName + '%', res.homeTeam, res.awayTeam);

                    const targetLive = liveList.find(pred => {
                        if (!resultTimeMs) return true;
                        return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                    });

                    if (targetLive) {
                        const oddsJson = res.odds ? JSON.stringify(res.odds) : null;
                        const lInfo = db.prepare(`
                            UPDATE live_predictions
                            SET actual_score = ?, actual_ht_score = ?, scored_status = 1, bookmaker_odds = COALESCE(bookmaker_odds, ?)
                            WHERE id = ?
                        `).run(actualScore, actualHtScore, oddsJson, targetLive.id);
                        updatedLive += lInfo.changes;
                    }

                    // Match historical prediction
                    const historicalList = db.prepare(`
                        SELECT id, kickoff_timestamp
                        FROM historical_market_predictions
                        WHERE provider = 'sportybet' AND season_name LIKE ? AND home_team = ? AND away_team = ? AND actual_score IS NULL
                    `).all(leagueName + '%', res.homeTeam, res.awayTeam);

                    const targetHist = historicalList.find(pred => {
                        if (!resultTimeMs) return true;
                        return isSameDateTime(resultTimeMs, pred.kickoff_timestamp);
                    });

                    if (targetHist) {
                        const hInfo = db.prepare(`
                            UPDATE historical_market_predictions
                            SET actual_score = ?, actual_ht_score = ?
                            WHERE id = ?
                        `).run(actualScore, actualHtScore, targetHist.id);
                        updatedHistorical += hInfo.changes;
                    }
                }
            })();

            // Score pending picks + generate new picks for all active Sportybet seasons
            try {
                // Collect all distinct season names that have unsettled predictions or missing picks
                const activeSeasons = db.prepare(`
                    SELECT DISTINCT season_name FROM live_predictions
                    WHERE season_name LIKE 'Sportybet%'
                    ORDER BY id DESC LIMIT 20
                `).all().map(r => r.season_name);

                for (const sName of activeSeasons) {
                    try {
                        await updateAIPicksHistory(db, sName, dbPath);
                    } catch (e) {
                        console.error(`[Historical Sync] Error updating AI picks history for ${sName}:`, e.message);
                    }
                }
            } catch (e) {
                console.error("[Historical Sync] Error updating AI picks history:", e.message);
            }
            console.log(`[Historical Sync] Updated ${updatedHistorical} historical predictions and ${updatedLive} live predictions.`);
        } else {
            console.log("[Historical Sync] No results scraped.");
        }

        // Settle any pending predictions and history picks across all tables
        try {
            const settled = settlePendingAIPicks(db);
            if (settled > 0) {
                console.log(`[Historical Sync] Successfully settled ${settled} pending AI picks.`);
            }
            
            // Only consider voiding if pick kickoff is older than 3 hours with no score in any table
            const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
            const voidStmt = db.prepare("UPDATE ai_best_picks_history SET status = 'void' WHERE status = 'pending' AND kickoff_timestamp < ?");
            const info = voidStmt.run(threeHoursAgo);
            if (info.changes > 0) {
                console.log(`[Historical Sync] Voided ${info.changes} truly expired pending picks older than 3 hours.`);
            }
        } catch (cleanupErr) {
            console.error("[Historical Sync] Error during settlement pass:", cleanupErr.message);
        }

        return { success: true, updatedHistorical, updatedLive };
    } catch (err) {
        console.error("[Historical Sync] Error:", err.message);
        return { success: false, error: err.message };
    } finally {
        if (db) {
            try { db.close(); } catch(e) {}
        }
        if (browser) {
            try {
                // Prevent browser.close() from hanging the sync handler indefinitely
                await Promise.race([
                    browser.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timeout')), 5000))
                ]);
            } catch (e) {
                console.warn("[Historical Sync] Browser close warning:", e.message);
                try { await browser.disconnect(); } catch (err) {}
            }
        } else if (page) {
            await page.close().catch(()=>{});
        }
    }
}

module.exports = {
    scrapeHistoricalResultsSync,
    scrapeAndPredictLiveSportySeason
};
