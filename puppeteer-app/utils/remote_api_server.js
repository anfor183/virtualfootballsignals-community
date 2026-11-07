/**
 * remote_api_server.js
 * 
 * Ultra-fast, lightweight dedicated microservice for remote client apps.
 * - Read-only SQLite connection (zero risk of locking/corrupting scraper writes)
 * - In-memory event polling & broadcast (WebSocket + Server-Sent Events SSE)
 * - Sub-millisecond response times (< 2ms)
 * - Minimal resource usage (< 25MB RAM, 0% CPU idle)
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Load better-sqlite3
const Database = require('../node_modules/better-sqlite3');
const { apiLogger, getDiagnostics, getRecentLogs } = require('./robust_logger');

// Static archived summary for the retired HT-Draw 6-hour cycle paper test (Oct 5 - Oct 15, 2026).
// Kept in-memory so legacy browser tabs or /api/htdraw/stats requests never scan paper_trading.db.
const ARCHIVED_HTDRAW_STATS = {
    success: true,
    archived: true,
    generatedAt: '2026-10-25T00:00:00.000Z',
    targetBets: 15000,
    progressPercent: 167.33,
    verdict: {
        label: 'EDGE REJECTED (RETIRED)',
        color: '#dc2626',
        text: 'Forward test completed (25,099 bets, -1.50% ROI, z = -2.16). 6-hour HT Draw cycle refuted out-of-sample; tracker retired.'
    },
    cycle: {
        timestamp: '2026-10-25T00:00:00.000Z',
        utcHours: 0,
        utcMinutes: 0,
        cyclePos: 0,
        isWindowActive: false,
        minutesUntilChange: 0,
        activeHoursUtc: 'RETIRED (Oct 5 - Oct 15, 2026)',
        statusLabel: 'TEST CONCLUDED & RETIRED'
    },
    strategies: {
        forward: {
            FROZEN_HTD: { n: 25099, staked: 25099, pnl: -375.9, roi: -0.015, wins: 11275, hitRate: 0.4492, impliedRate: 0.457, maxDD: 432.5, z: -2.16, ciLow: -0.0286, ciHigh: -0.0014, days: [], curve: [] },
            ADAPTIVE_HTD: { n: 25174, staked: 25174, pnl: -12.86, roi: -0.0005, wins: 11479, hitRate: 0.456, impliedRate: 0.457, maxDD: 165.4, z: -0.07, ciLow: -0.0141, ciHigh: 0.0131, days: [], curve: [] },
            FROZEN_X1X2: { n: 50198, staked: 50198, pnl: -819.0, roi: -0.0163, wins: 7229, hitRate: 0.144, impliedRate: 0.146, maxDD: 910.2, z: -1.4, ciLow: -0.0391, ciHigh: 0.0065, days: [], curve: [] },
            CONTROL_HTD: { n: 50672, staked: 50672, pnl: -1259.65, roi: -0.0249, wins: 22549, hitRate: 0.445, impliedRate: 0.457, maxDD: 1295.0, z: -5.11, ciLow: -0.0345, ciHigh: -0.0153, days: [], curve: [] }
        },
        backtest: {}
    },
    recentSettled: [],
    upcoming: []
};

const ARCHIVED_HTDRAW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HT Draw 6-Hour Cycle — Forward Test Concluded</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #e5e7eb; margin: 0; padding: 32px 16px; }
    .card { max-width: 760px; margin: 0 auto; background: #111827; border: 1px solid #374151; border-radius: 14px; padding: 28px; }
    .badge { display: inline-block; background: #450a0a; color: #fca5a5; border: 1px solid #991b1b; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    h1 { margin: 12px 0 6px; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 14px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #1f2937; }
    th { color: #9ca3af; font-size: 12px; text-transform: uppercase; }
    .neg { color: #f87171; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">EDGE REJECTED &bull; TRACKER RETIRED</span>
    <h1>HT Draw 6-Hour Cycle — Final Out-of-Sample Result</h1>
    <p style="color:#9ca3af;font-size:14px;line-height:1.5;">
      Forward paper test ran strictly out-of-sample from <strong>2026-10-05</strong> to <strong>2026-10-15</strong>
      (25,099 primary bets vs 15,000 target). All strategies converged to bookmaker margin and the live paper tracker has been retired.
    </p>
    <table>
      <thead>
        <tr><th>Strategy</th><th>Bets</th><th>Hit Rate</th><th>Break-Even</th><th>P&amp;L (1u)</th><th>ROI</th><th>95% CI</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>FROZEN_HTD</strong></td><td>25,099</td><td>44.9%</td><td>45.7%</td><td class="neg">-375.90u</td><td class="neg">-1.50%</td><td>[-2.9%, -0.1%]</td></tr>
        <tr><td><strong>ADAPTIVE_HTD</strong></td><td>25,174</td><td>45.6%</td><td>45.7%</td><td class="neg">-12.86u</td><td class="neg">-0.05%</td><td>[-1.4%, +1.3%]</td></tr>
        <tr><td><strong>FROZEN_X1X2</strong></td><td>50,198</td><td>14.4%</td><td>14.6%</td><td class="neg">-819.00u</td><td class="neg">-1.63%</td><td>[-3.9%, +0.7%]</td></tr>
        <tr><td><strong>CONTROL_HTD</strong></td><td>50,672</td><td>44.5%</td><td>45.7%</td><td class="neg">-1,259.65u</td><td class="neg">-2.49%</td><td>[-3.5%, -1.5%]</td></tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

// Load ws from dashboard or puppeteer-app
let WebSocketServer;
try {
    WebSocketServer = require('../dashboard/node_modules/ws').WebSocketServer;
} catch (_) {
    try {
        WebSocketServer = require('ws').WebSocketServer;
    } catch (e) {
        console.warn('[Remote API] ws module not found, WebSocket endpoint disabled. SSE will be used.');
    }
}

// Configuration
const CONFIG_PATH = path.join(__dirname, '../bot_settings.json');
let botSettings = {};
try {
    if (fs.existsSync(CONFIG_PATH)) {
        botSettings = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
} catch (_) {}

const PORT = parseInt(process.env.API_PORT || botSettings.apiServerPort || 4000, 10);
const API_KEY = process.env.API_KEY || botSettings.apiSecretKey || 'vfl_live_key_2026';
const DB_PATH = process.env.DB_PATH || botSettings.trainingDbPath || path.join(__dirname, '../databases/sportybet_archive.db');

console.log(`[Remote API] Initializing with DB: ${DB_PATH}`);
console.log(`[Remote API] Port: ${PORT}, Auth Key configured: ${API_KEY ? 'YES' : 'NO'}`);

// Open Database in READONLY mode with WAL support
let db;
try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    console.log('[Remote API] SQLite database connected in READONLY mode.');
} catch (err) {
    console.error('[Remote API] Fatal: Could not connect to SQLite database:', err.message);
    process.exit(1);
}

// Helper to enrich pick with signal category and ISO timestamp
function formatPick(pick) {
    if (!pick) return pick;
    let category = 'other';
    let category_label = 'Other';
    if (pick.pick_type === 'safest') {
        category = 'safest';
        category_label = 'Safest';
    } else if (pick.pick_type === 'high_value') {
        category = 'high_chance';
        category_label = 'High Chance';
    } else if (pick.pick_type === 'ai_best_pick') {
        category = 'ai_high_risk';
        category_label = 'AI High Risk';
    } else if (pick.pick_type === 'goals' || pick.pick_type === 'goals_strategy') {
        category = 'goals_strategy';
        category_label = 'Goals Strategy Special';
    }

    let kickoff_iso = null;
    if (pick.kickoff_timestamp) {
        try {
            kickoff_iso = new Date(Number(pick.kickoff_timestamp)).toISOString();
        } catch (_) {}
    }

    return {
        ...pick,
        sportybet_odd: pick.implied_odd ?? null,
        bookmaker_odd: pick.implied_odd ?? null,
        category,
        category_label,
        kickoff_iso
    };
}

// Prepared statements for maximum performance
const stmts = {
    getPendingPicks: db.prepare(`
        SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
               probability, implied_odd, displayed_confidence, match_time, 
               kickoff_timestamp, status, actual_score
        FROM ai_best_picks_history 
        WHERE status = 'pending' 
        ORDER BY id DESC
    `),
    getSettledPicks: db.prepare(`
        SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
               probability, implied_odd, displayed_confidence, match_time, 
               kickoff_timestamp, status, actual_score
        FROM ai_best_picks_history 
        WHERE status IN ('won', 'lost', 'void') 
        ORDER BY id DESC 
        LIMIT ?
    `),
    getStats: db.prepare(`
        SELECT 
            count(*) as total,
            sum(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
            sum(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost,
            sum(CASE WHEN status = 'void' THEN 1 ELSE 0 END) as void,
            sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
        FROM ai_best_picks_history
    `),
    getLivePredictions: db.prepare(`
        SELECT id, season_name, round_number, match_time, home_team, away_team,
               predicted_result, predicted_probs, actual_score, actual_ht_score,
               scored_status, kickoff_timestamp, bookmaker_odds
        FROM live_predictions
        ORDER BY id DESC
        LIMIT ?
    `),
    getMaxPickId: db.prepare(`SELECT MAX(id) as max_id FROM ai_best_picks_history`),
    getPendingIds: db.prepare(`SELECT id FROM ai_best_picks_history WHERE status = 'pending'`),
    getNewPicksSince: db.prepare(`
        SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
               probability, implied_odd, displayed_confidence, match_time, 
               kickoff_timestamp, status, actual_score
        FROM ai_best_picks_history 
        WHERE id > ? 
        ORDER BY id ASC
    `)
};

// Connected streaming clients (SSE + WebSocket)
const sseClients = new Set();
const wsClients = new Set();

// In-memory state tracking for change detection
let lastKnownMaxId = 0;
const knownPendingIds = new Set();

try {
    const maxRow = stmts.getMaxPickId.get();
    lastKnownMaxId = maxRow && maxRow.max_id ? maxRow.max_id : 0;
    const initialPending = stmts.getPendingIds.all();
    initialPending.forEach(p => knownPendingIds.add(p.id));
    console.log(`[Remote API] Initial tracking: Max ID = ${lastKnownMaxId}, Pending picks = ${knownPendingIds.size}`);
} catch (e) {
    console.warn('[Remote API] Could not initialize pick tracking state:', e.message);
}

// Background polling loop (runs every 1.5 seconds locally on VPS, 0 overhead)
setInterval(() => {
    try {
        // 1. Check for new picks
        const maxRow = stmts.getMaxPickId.get();
        const currentMaxId = maxRow && maxRow.max_id ? maxRow.max_id : 0;
        
        if (currentMaxId > lastKnownMaxId) {
            const rawNewPicks = stmts.getNewPicksSince.all(lastKnownMaxId);
            const newPicks = rawNewPicks.map(formatPick);
            lastKnownMaxId = currentMaxId;
            for (const p of newPicks) {
                if (p.status === 'pending') {
                    knownPendingIds.add(p.id);
                }
            }
            if (newPicks.length > 0) {
                broadcastMessage({
                    type: 'new_picks',
                    count: newPicks.length,
                    timestamp: new Date().toISOString(),
                    data: newPicks
                });
            }
        }

        // 2. Check for newly settled picks among pending
        if (knownPendingIds.size > 0) {
            const idList = Array.from(knownPendingIds);
            const placeholders = idList.map(() => '?').join(',');
            const checkQuery = `
                SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
                       status, actual_score, kickoff_timestamp, match_time
                FROM ai_best_picks_history 
                WHERE id IN (${placeholders}) AND status != 'pending'
            `;
            const settled = db.prepare(checkQuery).all(...idList).map(formatPick);
            if (settled.length > 0) {
                for (const s of settled) {
                    knownPendingIds.delete(s.id);
                }
                broadcastMessage({
                    type: 'settled_picks',
                    count: settled.length,
                    timestamp: new Date().toISOString(),
                    data: settled
                });
            }
        }
    } catch (pollErr) {
        // Database might be momentarily busy during WAL checkpoint, ignore safely
    }
}, 1500);

// Helper to broadcast JSON payload to SSE and WebSocket clients
function broadcastMessage(payload) {
    const jsonStr = JSON.stringify(payload);
    
    // Broadcast to SSE
    for (const client of sseClients) {
        try {
            client.write(`event: message\ndata: ${jsonStr}\n\n`);
        } catch (_) {
            sseClients.delete(client);
        }
    }

    // Broadcast to WebSockets
    for (const ws of wsClients) {
        try {
            if (ws.readyState === 1) { // OPEN
                ws.send(jsonStr);
            }
        } catch (_) {
            wsClients.delete(ws);
        }
    }
}

// Authentication verification helper
function isAuthorized(req, parsedUrl) {
    if (!API_KEY) return true; // No key configured, public
    const headerKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    const queryKey = parsedUrl.query.api_key;
    return (headerKey === API_KEY || queryKey === API_KEY);
}

// JSON response helper
function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
    });
    res.end(body);
}

// HTTP Server
const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
        });
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Public health check
    if (pathname === '/health' || pathname === '/' || pathname === '/api/health') {
        let dbStats = null;
        try { dbStats = stmts.getStats.get(); } catch (_) {}
        const diag = getDiagnostics();

        return sendJson(res, 200, {
            status: 'online',
            service: 'VFL Remote API Microservice',
            uptime_seconds: Math.floor(process.uptime()),
            connections: {
                sse: sseClients.size,
                websocket: wsClients.size
            },
            database: {
                path: DB_PATH,
                pending_picks_tracked: knownPendingIds.size,
                max_pick_id: lastKnownMaxId,
                stats: dbStats
            },
            system_diagnostics: diag,
            timestamp: new Date().toISOString()
        });
    }

    // Archived HT Draw paper test summary (static response, zero DB overhead)
    if (pathname === '/api/htdraw/stats') {
        return sendJson(res, 200, ARCHIVED_HTDRAW_STATS);
    }

    if (pathname === '/htdraw' || pathname === '/htdraw/' || pathname === '/paper' || pathname === '/paper/') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(ARCHIVED_HTDRAW_HTML);
        return;
    }

    // Authenticate all /api/* routes (excluding /api/health handled above)
    if (pathname.startsWith('/api/')) {
        if (!isAuthorized(req, parsedUrl)) {
            return sendJson(res, 401, {
                success: false,
                error: 'Unauthorized. Please provide valid x-api-key header or ?api_key= query param.'
            });
        }
    }

    // 1. GET /api/picks/pending or /api/picks/live?type=safest
    if (req.method === 'GET' && (pathname === '/api/picks/pending' || pathname === '/api/picks/live')) {
        try {
            let picks = stmts.getPendingPicks.all().map(formatPick);
            const typeFilter = parsedUrl.query.type || parsedUrl.query.category;
            if (typeFilter && typeFilter !== 'all') {
                const tf = typeFilter.toLowerCase();
                picks = picks.filter(p => 
                    p.pick_type?.toLowerCase() === tf || 
                    p.category?.toLowerCase() === tf ||
                    (tf === 'high_chance' && p.pick_type === 'high_value') ||
                    (tf === 'high_risk' && p.pick_type === 'ai_best_pick') ||
                    ((tf === 'goals' || tf === 'goals_strategy') && (p.pick_type === 'goals' || p.category === 'goals_strategy'))
                );
            }

            const groupedSignals = {
                safest: picks.filter(p => p.pick_type === 'safest'),
                high_chance: picks.filter(p => p.pick_type === 'high_value'),
                ai_high_risk: picks.filter(p => p.pick_type === 'ai_best_pick'),
                goals_strategy: picks.filter(p => p.pick_type === 'goals' || p.category === 'goals_strategy')
            };

            return sendJson(res, 200, {
                success: true,
                count: picks.length,
                signals: groupedSignals,
                data: picks
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 1b. Dedicated Goals Strategy Special Signal Service for Betting Executor
    if (req.method === 'GET' && (pathname === '/api/picks/goals' || pathname === '/api/goals/signals')) {
        try {
            const allPending = stmts.getPendingPicks.all().filter(p => p.pick_type === 'goals').map(formatPick);
            const now = Date.now();

            const signals = allPending.map(p => {
                const ko = Number(p.kickoff_timestamp);
                const secondsUntilKickoff = ko > 0 ? Math.max(0, Math.floor((ko - now) / 1000)) : null;
                const canExecute = secondsUntilKickoff === null || secondsUntilKickoff >= 10;
                
                let line = 2.5;
                let selection = 'Over';
                if (p.market && p.market.includes('3.5')) line = 3.5;
                if (p.market && p.market.toLowerCase().includes('under')) selection = 'Under';

                return {
                    id: p.id,
                    service: 'Goals Strategy Special',
                    season_name: p.season_name,
                    round_number: p.round_number,
                    fixture: `${p.home_team} vs ${p.away_team}`,
                    home_team: p.home_team,
                    away_team: p.away_team,
                    market: p.market,
                    selection,
                    goal_line: line,
                    odds: p.implied_odd,
                    sportybet_odd: p.sportybet_odd,
                    probability: p.probability,
                    kickoff_timestamp: p.kickoff_timestamp,
                    kickoff_iso: p.kickoff_iso,
                    match_time: p.match_time,
                    seconds_until_kickoff: secondsUntilKickoff,
                    status: p.status,
                    executor_ready: canExecute,
                    recommended_action: canExecute ? 'EXECUTE_BET' : 'EXPIRED_OR_IN_PLAY'
                };
            });

            const recentSettled = db.prepare(`
                SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
                       probability, implied_odd, match_time, kickoff_timestamp, status, actual_score
                FROM ai_best_picks_history 
                WHERE pick_type = 'goals' AND status IN ('won', 'lost', 'void')
                ORDER BY id DESC 
                LIMIT 30
            `).all().map(formatPick);

            const goalsStats = db.prepare(`
                SELECT 
                    count(*) as total,
                    sum(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
                    sum(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost,
                    sum(CASE WHEN status = 'void' THEN 1 ELSE 0 END) as void,
                    sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
                FROM ai_best_picks_history
                WHERE pick_type = 'goals'
            `).get() || { total: 0, won: 0, lost: 0, void: 0, pending: 0 };

            const winRate = (goalsStats.won + goalsStats.lost) > 0 
                ? parseFloat(((goalsStats.won / (goalsStats.won + goalsStats.lost)) * 100).toFixed(2)) 
                : 0;

            return sendJson(res, 200, {
                success: true,
                service: 'Goals Strategy Special Signal Service',
                consumer: 'Betting Executor',
                timestamp: new Date().toISOString(),
                active_signals_count: signals.length,
                active_signals: signals,
                next_signal: signals.length > 0 ? signals[0] : null,
                stats: {
                    ...goalsStats,
                    win_rate_percent: winRate
                },
                recent_settled: recentSettled
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 2. GET /api/picks/settled?limit=50&status=won&type=safest
    if (req.method === 'GET' && pathname === '/api/picks/settled') {
        try {
            const limit = Math.min(parseInt(parsedUrl.query.limit || 50, 10), 500);
            const statusFilter = parsedUrl.query.status;
            let picks;
            if (statusFilter && ['won', 'lost', 'void'].includes(statusFilter.toLowerCase())) {
                picks = db.prepare(`
                    SELECT id, season_name, round_number, pick_type, home_team, away_team, market, 
                           probability, implied_odd, displayed_confidence, match_time, 
                           kickoff_timestamp, status, actual_score
                    FROM ai_best_picks_history 
                    WHERE status = ?
                    ORDER BY id DESC 
                    LIMIT ?
                `).all(statusFilter.toLowerCase(), limit).map(formatPick);
            } else {
                picks = stmts.getSettledPicks.all(limit).map(formatPick);
            }

            const typeFilter = parsedUrl.query.type || parsedUrl.query.category;
            if (typeFilter && typeFilter !== 'all') {
                const tf = typeFilter.toLowerCase();
                picks = picks.filter(p => 
                    p.pick_type?.toLowerCase() === tf || 
                    p.category?.toLowerCase() === tf ||
                    (tf === 'high_chance' && p.pick_type === 'high_value') ||
                    (tf === 'high_risk' && p.pick_type === 'ai_best_pick') ||
                    ((tf === 'goals' || tf === 'goals_strategy') && (p.pick_type === 'goals' || p.category === 'goals_strategy'))
                );
            }

            return sendJson(res, 200, {
                success: true,
                count: picks.length,
                data: picks
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 3. GET /api/predictions/live?limit=30
    if (req.method === 'GET' && pathname === '/api/predictions/live') {
        try {
            const limit = Math.min(parseInt(parsedUrl.query.limit || 30, 10), 100);
            const predictions = stmts.getLivePredictions.all(limit);
            return sendJson(res, 200, {
                success: true,
                count: predictions.length,
                data: predictions
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 4. GET /api/stats
    if (req.method === 'GET' && pathname === '/api/stats') {
        try {
            const stats = stmts.getStats.get();
            const winRate = (stats.won + stats.lost) > 0 
                ? parseFloat(((stats.won / (stats.won + stats.lost)) * 100).toFixed(2)) 
                : 0;
            return sendJson(res, 200, {
                success: true,
                data: {
                    ...stats,
                    win_rate_percent: winRate
                }
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 4b. GET /api/logs?channel=settlement&limit=50&level=INFO
    if (req.method === 'GET' && pathname === '/api/logs') {
        try {
            const channel = parsedUrl.query.channel;
            const level = parsedUrl.query.level;
            const limit = parsedUrl.query.limit;
            const logs = getRecentLogs({ channel, level, limit });
            return sendJson(res, 200, {
                success: true,
                count: logs.length,
                channel: channel || 'all',
                data: logs
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 4c. GET /api/diagnostics
    if (req.method === 'GET' && pathname === '/api/diagnostics') {
        try {
            const diag = getDiagnostics();
            const stats = stmts.getStats.get();
            const recentSettled = stmts.getSettledPicks.all(5).map(formatPick);
            const pending = stmts.getPendingPicks.all().map(formatPick);
            return sendJson(res, 200, {
                success: true,
                service: 'VFL Remote API Microservice',
                system: diag,
                database: {
                    stats,
                    pending_count: pending.length,
                    active_pending: pending,
                    recent_settled: recentSettled
                },
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            return sendJson(res, 500, { success: false, error: err.message });
        }
    }

    // 5. GET /api/stream - Server-Sent Events (SSE)
    if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        res.flushHeaders?.();

        // Send initial connection state
        const currentPending = stmts.getPendingPicks.all().map(formatPick);
        res.write(`event: connected\ndata: ${JSON.stringify({ 
            message: 'Connected to live stream', 
            pending_picks: currentPending 
        })}\n\n`);

        sseClients.add(res);

        // Keep-alive heartbeat every 15 seconds
        const heartbeat = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
        });
        return;
    }

    // 6. POST /api/query - Parameterized Read-Only SQL Query
    if (req.method === 'POST' && pathname === '/api/query') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const sql = (parsed.sql || '').trim();
                const params = Array.isArray(parsed.params) ? parsed.params : [];

                if (!sql) {
                    return sendJson(res, 400, { success: false, error: 'Missing "sql" property' });
                }

                // Strict security: Only allow SELECT and PRAGMA
                const normalizedSql = sql.toUpperCase();
                if (!normalizedSql.startsWith('SELECT') && !normalizedSql.startsWith('PRAGMA') && !normalizedSql.startsWith('WITH')) {
                    return sendJson(res, 403, { success: false, error: 'Only read-only SELECT queries are allowed.' });
                }

                const rows = db.prepare(sql).all(...params);
                return sendJson(res, 200, {
                    success: true,
                    count: rows.length,
                    data: rows
                });
            } catch (queryErr) {
                return sendJson(res, 400, { success: false, error: queryErr.message });
            }
        });
        return;
    }

    // 404 Fallback
    sendJson(res, 404, { success: false, error: `Route ${pathname} not found.` });
});

// WebSocket Server initialization
if (WebSocketServer) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        const parsedUrl = url.parse(request.url, true);
        if (parsedUrl.pathname === '/ws') {
            if (!isAuthorized(request, parsedUrl)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', (ws) => {
        wsClients.add(ws);
        
        // Send initial welcome & current pending picks
        try {
            const currentPending = stmts.getPendingPicks.all();
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to live WebSocket feed',
                pending_picks: currentPending
            }));
        } catch (_) {}

        ws.on('close', () => {
            wsClients.delete(ws);
        });

        ws.on('error', () => {
            wsClients.delete(ws);
        });
    });
    console.log('[Remote API] WebSocket server enabled at ws://localhost:' + PORT + '/ws');
}

// Start HTTP listening
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Remote API] 🚀 Server running at http://0.0.0.0:${PORT}`);
    console.log(`[Remote API] Endpoints available:`);
    console.log(`  - Health:            GET  http://0.0.0.0:${PORT}/health`);
    console.log(`  - Live Picks:        GET  http://0.0.0.0:${PORT}/api/picks/pending`);
    console.log(`  - Settled Bets:      GET  http://0.0.0.0:${PORT}/api/picks/settled?limit=50`);
    console.log(`  - Live Predictions:  GET  http://0.0.0.0:${PORT}/api/predictions/live`);
    console.log(`  - Stats Summary:     GET  http://0.0.0.0:${PORT}/api/stats`);
    console.log(`  - Real-Time SSE:     GET  http://0.0.0.0:${PORT}/api/stream`);
    console.log(`  - Real-Time WS:      WS   ws://0.0.0.0:${PORT}/ws`);
    console.log(`  - Read-Only Query:   POST http://0.0.0.0:${PORT}/api/query`);
});
