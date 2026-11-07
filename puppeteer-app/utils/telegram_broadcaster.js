/**
 * utils/telegram_broadcaster.js
 * 
 * Centralized, production-grade Telegram Broadcaster Service for NexusPanel.
 * Completely revamped for elite visual presentation, high readability, and reliable automation.
 * 
 * Supports:
 *  - 6 Core Broadcast Modes:
 *      1. 'ai_all': Bundled Executive Round Card (Safest + High Value + High-Risk AI Pick + Verified Win Rates)
 *      2. 'safest': Safest Pick Focus Card (High Probability / Conservative Staking)
 *      3. 'high_value': High Value Pick Focus Card (Positive Expected Value / Edge)
 *      4. 'ai_only': High-Risk AI Best Pick Card (High-Yield Underdogs / HT-FT / Burst ROI)
 *      5. 'confidence_filtered': High Confidence Filtered Signals (Configurable Min Confidence %)
 *      6. 'all': Upcoming Fixtures Schedule Card (All Matches in Round)
 *  - Automated Scored Match Results Cards with Win/Loss outcome badges, exact scores, net units, and streaks
 *  - Automated Hot Streak Celebration Cards (3, 5, 7, 10+ consecutive wins)
 *  - Automated Daily Performance Digest Reports (PnL, total settled, ROI, win rate %)
 *  - Persistent SQLite deduplication (`telegram_sent_log`) with 14-day auto-pruning
 *  - Paced Message Queue with rate-limit protection & auto-retry on 429
 *  - VIP Group & Private Subscriber DM routing
 *  - VIP Supergroup Auto-Kick for expired licenses
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const https = require('https');

const DEFAULT_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const DEFAULT_CHAT_ID   = 'YOUR_TELEGRAM_CHAT_ID';
const DEFAULT_CHANNEL_TITLE = 'NEXUS Sportybet/Golden Race England VFL Premium Tips';
const DEFAULT_TAGLINE = 'Official AI Virtual Signals Community';
const DEFAULT_FOOTER = '⚠️ <i>Play responsibly. Strict 20-30 bets/day limit recommended. 18+</i>';

// ── In-Memory Deduplication & Rate Limiting Cache ───────────────────────────
const inMemorySentKeys = new Set();

/**
 * Load Telegram settings from bot_settings.json or fallback defaults
 */
function loadTelegramSettings(customSettings = {}) {
    let settings = {};
    const settingsPath = path.resolve(__dirname, '../bot_settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (_) {}
    }

    const confFilter = Number(
        customSettings.confidenceFilter !== undefined ? customSettings.confidenceFilter :
        (customSettings.sportyConfidenceFilter !== undefined ? customSettings.sportyConfidenceFilter :
        (settings.confidenceFilter !== undefined ? settings.confidenceFilter :
        (settings.sportyConfidenceFilter !== undefined ? settings.sportyConfidenceFilter : 50)))
    );

    const autoSendConf = customSettings.autoSendConfidencePicks !== undefined
        ? Boolean(customSettings.autoSendConfidencePicks)
        : (settings.autoSendConfidencePicks !== undefined ? Boolean(settings.autoSendConfidencePicks) : false);

    const autoSendConfRes = customSettings.autoSendConfidenceResults !== undefined
        ? Boolean(customSettings.autoSendConfidenceResults)
        : (settings.autoSendConfidenceResults !== undefined ? Boolean(settings.autoSendConfidenceResults) : true);

    const autoSendStreaks = customSettings.autoSendStreakAlerts !== undefined
        ? Boolean(customSettings.autoSendStreakAlerts)
        : (settings.autoSendStreakAlerts !== undefined ? Boolean(settings.autoSendStreakAlerts) : true);

    const autoSendDaily = customSettings.autoSendDailyDigest !== undefined
        ? Boolean(customSettings.autoSendDailyDigest)
        : (settings.autoSendDailyDigest !== undefined ? Boolean(settings.autoSendDailyDigest) : true);

    return {
        botToken: customSettings.telegramBotToken || settings.telegramBotToken || DEFAULT_BOT_TOKEN,
        chatId: customSettings.telegramChatId || settings.telegramChatId || DEFAULT_CHAT_ID,
        vipGroupId: customSettings.telegramVipGroupId || settings.telegramVipGroupId || '',
        channelTitle: customSettings.telegramChannelTitle || settings.telegramChannelTitle || DEFAULT_CHANNEL_TITLE,
        tagline: customSettings.telegramTagline || settings.telegramTagline || DEFAULT_TAGLINE,
        footer: customSettings.telegramFooter || settings.telegramFooter || DEFAULT_FOOTER,
        targetChannel: customSettings.telegramTargetChannel || settings.telegramTargetChannel || 'main',
        autoPost: settings.autoPostToTelegram !== undefined ? Boolean(settings.autoPostToTelegram)
            : (customSettings.autoPostToTelegram !== undefined ? Boolean(customSettings.autoPostToTelegram) : true),
        // Subscriber feed policy is server-owned; stale browser settings cannot reopen raw streams.
        feedStyle: settings.telegramFeedStyle === 'legacy' ? 'legacy' : 'curated',
        dailySignalLimit: Math.max(1,Math.min(20,Number(settings.telegramDailySignalLimit)||20)),
        signalGapMinutes: Math.max(30,Number(settings.telegramSignalGapMinutes)||30),
        broadcastMode: customSettings.telegramPickFilter || settings.telegramPickFilter || 'ai_all',
        broadcastFrequency: Number(customSettings.telegramBroadcastFrequency || settings.telegramBroadcastFrequency || 1),
        autoKickExpiredVips: Boolean(customSettings.autoKickExpiredVips !== undefined ? customSettings.autoKickExpiredVips : settings.autoKickExpiredVips),
        autoSendConfidencePicks: autoSendConf,
        confidenceFilter: confFilter,
        sportyConfidenceFilter: confFilter,
        autoSendConfidenceResults: autoSendConfRes,
        autoSendStreakAlerts: autoSendStreaks,
        autoSendDailyDigest: autoSendDaily,
        subscribers: Array.isArray(customSettings.subscribers) ? customSettings.subscribers : (Array.isArray(settings.subscribers) ? settings.subscribers : [])
    };
}

/**
 * Save Telegram configuration to bot_settings.json
 */
function saveTelegramSettings(newSettings = {}) {
    const settingsPath = path.resolve(__dirname, '../bot_settings.json');
    let current = {};
    if (fs.existsSync(settingsPath)) {
        try {
            current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch (_) {}
    }

    const confVal = newSettings.confidenceFilter !== undefined ? Number(newSettings.confidenceFilter) :
        (newSettings.sportyConfidenceFilter !== undefined ? Number(newSettings.sportyConfidenceFilter) :
        (current.confidenceFilter !== undefined ? Number(current.confidenceFilter) :
        (current.sportyConfidenceFilter !== undefined ? Number(current.sportyConfidenceFilter) : 50)));

    const updated = {
        ...current,
        telegramFeedStyle: newSettings.telegramFeedStyle === 'legacy' ? 'legacy' : (newSettings.telegramFeedStyle === 'curated' ? 'curated' : current.telegramFeedStyle || 'curated'),
        telegramDailySignalLimit: Math.max(1,Math.min(20,Number(newSettings.telegramDailySignalLimit ?? current.telegramDailySignalLimit)||20)),
        telegramSignalGapMinutes: Math.max(30,Number(newSettings.telegramSignalGapMinutes ?? current.telegramSignalGapMinutes)||30),
        telegramBotToken: newSettings.telegramBotToken !== undefined ? newSettings.telegramBotToken : (current.telegramBotToken || DEFAULT_BOT_TOKEN),
        telegramChatId: newSettings.telegramChatId !== undefined ? newSettings.telegramChatId : (current.telegramChatId || DEFAULT_CHAT_ID),
        telegramVipGroupId: newSettings.telegramVipGroupId !== undefined ? newSettings.telegramVipGroupId : (current.telegramVipGroupId || ''),
        telegramChannelTitle: newSettings.telegramChannelTitle !== undefined ? newSettings.telegramChannelTitle : (current.telegramChannelTitle || DEFAULT_CHANNEL_TITLE),
        telegramTagline: newSettings.telegramTagline !== undefined ? newSettings.telegramTagline : (current.telegramTagline || DEFAULT_TAGLINE),
        telegramFooter: newSettings.telegramFooter !== undefined ? newSettings.telegramFooter : (current.telegramFooter || DEFAULT_FOOTER),
        telegramTargetChannel: newSettings.telegramTargetChannel !== undefined ? newSettings.telegramTargetChannel : (current.telegramTargetChannel || 'main'),
        autoPostToTelegram: newSettings.autoPostToTelegram !== undefined ? Boolean(newSettings.autoPostToTelegram) : (current.autoPostToTelegram !== undefined ? Boolean(current.autoPostToTelegram) : true),
        telegramPickFilter: newSettings.telegramPickFilter !== undefined ? newSettings.telegramPickFilter : (current.telegramPickFilter || 'ai_all'),
        telegramBroadcastFrequency: newSettings.telegramBroadcastFrequency !== undefined ? Number(newSettings.telegramBroadcastFrequency) : (current.telegramBroadcastFrequency || 1),
        autoKickExpiredVips: newSettings.autoKickExpiredVips !== undefined ? Boolean(newSettings.autoKickExpiredVips) : Boolean(current.autoKickExpiredVips),
        autoSendConfidencePicks: newSettings.autoSendConfidencePicks !== undefined ? Boolean(newSettings.autoSendConfidencePicks) : Boolean(current.autoSendConfidencePicks),
        confidenceFilter: confVal,
        sportyConfidenceFilter: confVal,
        autoSendConfidenceResults: newSettings.autoSendConfidenceResults !== undefined ? Boolean(newSettings.autoSendConfidenceResults) : (current.autoSendConfidenceResults !== undefined ? Boolean(current.autoSendConfidenceResults) : true),
        autoSendStreakAlerts: newSettings.autoSendStreakAlerts !== undefined ? Boolean(newSettings.autoSendStreakAlerts) : (current.autoSendStreakAlerts !== undefined ? Boolean(current.autoSendStreakAlerts) : true),
        autoSendDailyDigest: newSettings.autoSendDailyDigest !== undefined ? Boolean(newSettings.autoSendDailyDigest) : (current.autoSendDailyDigest !== undefined ? Boolean(current.autoSendDailyDigest) : true)
    };

    try {
        fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (err) {
        console.error('[Telegram Broadcaster] Error writing bot_settings.json:', err.message);
    }
    return updated;
}

/**
 * Open SQLite database safely with concurrency & WAL settings
 */
function openDatabase(dbOrPath) {
    if (!dbOrPath) return { db: null, shouldClose: false, error: 'Database path not provided' };
    if (typeof dbOrPath === 'object' && typeof dbOrPath.prepare === 'function') {
        return { db: dbOrPath, shouldClose: false };
    }
    if (typeof dbOrPath === 'string') {
        if (!fs.existsSync(dbOrPath)) return { db: null, shouldClose: false, error: `Database not found: ${dbOrPath}` };
        try {
            const db = new Database(dbOrPath, { timeout: 10000 });
            try {
                db.pragma('journal_mode = WAL');
                db.pragma('busy_timeout = 5000');
            } catch (_) {}
            return { db, shouldClose: true };
        } catch (err) {
            return { db: null, shouldClose: false, error: err.message };
        }
    }
    return { db: null, shouldClose: false, error: 'Invalid database argument' };
}

/**
 * Ensure `telegram_sent_log` exists and prune records older than 14 days
 */
function ensureTelegramLogTable(db) {
    if (!db) return;
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS telegram_sent_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_key TEXT UNIQUE,
                msg_type TEXT,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_tg_sent_key ON telegram_sent_log(msg_key);
        `);
        // Prune old logs once every few runs
        if (Math.random() < 0.1) {
            db.exec("DELETE FROM telegram_sent_log WHERE sent_at < datetime('now', '-14 days')");
        }
    } catch (_) {}
}

/**
 * Check if message key was already sent
 */
function isKeySent(db, key) {
    if (!key) return false;
    if (inMemorySentKeys.has(key)) return true;
    if (!db) return false;
    try {
        ensureTelegramLogTable(db);
        const row = db.prepare('SELECT 1 FROM telegram_sent_log WHERE msg_key = ? LIMIT 1').get(key);
        if (row) {
            inMemorySentKeys.add(key);
            return true;
        }
    } catch (_) {}
    return false;
}

/**
 * Mark message key as sent in memory and database
 */
function markKeySent(db, key, msgType = 'unknown') {
    if (!key) return;
    inMemorySentKeys.add(key);
    if (!db) return;
    try {
        ensureTelegramLogTable(db);
        db.prepare('INSERT OR IGNORE INTO telegram_sent_log (msg_key, msg_type) VALUES (?, ?)').run(key, msgType);
    } catch (_) {}
}

/**
 * Clear dedup sent log so predictions or results can be re-tested
 */
function clearTelegramDedupLog(dbOrPath) {
    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return { success: false, error };
    try {
        ensureTelegramLogTable(db);
        db.exec('DELETE FROM telegram_sent_log');
        inMemorySentKeys.clear();
        if (shouldClose) db.close();
        return { success: true, message: 'Telegram broadcast history cleared successfully' };
    } catch (err) {
        if (shouldClose) db.close();
        return { success: false, error: err.message };
    }
}

/**
 * Fetch recent telegram logs for audit and dashboard monitoring
 */
function getRecentTelegramLogs(dbOrPath, limit = 50) {
    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return [];
    try {
        ensureTelegramLogTable(db);
        const rows = db.prepare('SELECT * FROM telegram_sent_log ORDER BY id DESC LIMIT ?').all(limit);
        if (shouldClose) db.close();
        return rows;
    } catch (_) {
        if (shouldClose) db.close();
        return [];
    }
}

/**
 * Low-level paced sender; only explicit rate-limit rejections retry, never ambiguous sends
 */
async function sendRawTelegramMessage(botToken, chatId, text, parseMode = 'HTML') {
    return require('./telegram_transport').send(botToken,chatId,text,parseMode);
}

/**
 * Format Nigerian WAT Time
 */
function formatWAT(timestampOrStr) {
    if (!timestampOrStr) {
        return new Date().toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }) + ' WAT';
    }
    if (typeof timestampOrStr === 'string' && timestampOrStr.includes('WAT')) {
        return timestampOrStr.trim();
    }
    let d = null;
    if (typeof timestampOrStr === 'number' || (!isNaN(Number(timestampOrStr)) && String(timestampOrStr).trim().length >= 10)) {
        let n = Number(timestampOrStr);
        if (n < 10000000000) n *= 1000;
        d = new Date(n);
    } else if (typeof timestampOrStr === 'string') {
        const str = timestampOrStr.trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) {
            const parts = str.split(':').map(Number);
            return `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')} WAT`;
        }
        const matchFull = str.match(/(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
        if (matchFull) {
            if (str.includes('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
                d = new Date(str);
            } else {
                return `${matchFull[2]} WAT`;
            }
        } else {
            d = new Date(str);
        }
    } else if (timestampOrStr instanceof Date) {
        d = timestampOrStr;
    }

    if (d && !isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }) + ' WAT';
    }
    return `${timestampOrStr} WAT`;
}

/**
 * HTML escape helper for Telegram parse_mode: 'HTML'
 */
function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render visual monospaced progress/confidence meter for Telegram
 * E.g. [████████░░] 84%
 */
function renderConfidenceBar(pct) {
    const val = Math.max(0, Math.min(100, Math.round(Number(pct) || 50)));
    const filled = Math.min(10, Math.max(1, Math.round(val / 10)));
    const empty = 10 - filled;
    return `<code>[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${val}%</code>`;
}

/**
 * Derive clean, accurate opposite/hedge market tips
 * Returns null if no mathematically sensible opposite exists
 */
function getOppositeMarketTip(market) {
    if (!market) return null;
    const m = String(market).trim();
    if (/Over 2\.5/i.test(m)) return 'Under 2.5 Goals';
    if (/Under 2\.5/i.test(m)) return 'Over 2.5 Goals';
    if (/Over 1\.5/i.test(m)) return 'Under 1.5 Goals';
    if (/Under 1\.5/i.test(m)) return 'Over 1.5 Goals';
    if (/Over 3\.5/i.test(m)) return 'Under 3.5 Goals';
    if (/Under 3\.5/i.test(m)) return 'Over 3.5 Goals';
    if (/Home Win/i.test(m) || m === '1') return 'Away Win or Draw (X2)';
    if (/Away Win/i.test(m) || m === '2') return 'Home Win or Draw (1X)';
    if (/Draw/i.test(m) || m === 'X') return 'Home or Away Win (12)';
    if (/Both Teams to Score/i.test(m) || /\bGG\b/i.test(m)) return 'No Goal (NG)';
    if (/\bNG\b/i.test(m) || /No Goal/i.test(m)) return 'Both Teams to Score (GG)';
    if (/Home Draw No Bet/i.test(m) || /1 DNB/i.test(m)) return 'Away Win (2)';
    if (/Away Draw No Bet/i.test(m) || /2 DNB/i.test(m)) return 'Home Win (1)';
    if (/\b1X\b/i.test(m)) return 'Away Win (2)';
    if (/\bX2\b/i.test(m)) return 'Home Win (1)';
    if (/\b12\b/i.test(m)) return 'Draw (X)';
    if (/HT\/FT 1\/1/i.test(m)) return 'Draw or Away at HT/FT';
    if (/HT\/FT 2\/2/i.test(m)) return 'Draw or Home at HT/FT';
    return null;
}

/**
 * Clean and format platform display name
 */
function cleanPlatformTitle(platformName, seasonName) {
    const s = String(seasonName || '').toLowerCase();
    if (s.includes('england')) return 'SportyBet England VFL';
    if (s.includes('spain')) return 'SportyBet Spain VFL';
    if (s.includes('italy')) return 'SportyBet Italy VFL';
    if (s.includes('germany')) return 'SportyBet Germany VFL';
    if (s.includes('bet9ja')) return 'Bet9ja Premier League';
    return platformName || 'SportyBet VFL';
}

/**
 * Calculate match confidence score from predicted_probs
 */
function calculateConfidenceForPrediction(p) {
    if (!p) return 50;
    if (typeof p.confidence_score === 'number' && p.confidence_score > 0) {
        return Math.max(50, Math.min(98, Math.round(p.confidence_score)));
    }
    let pr = p.predicted_probs || {};
    if (typeof pr === 'string') {
        try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; }
    }
    const maxProb = Math.max(
        pr.homeWinProb || 0, pr.drawProb || 0, pr.awayWinProb || 0,
        pr.ggProb || 0, pr.over15Prob || 0, pr.over25Prob || 0
    ) / 100;
    let conf = Math.round(40 + (maxProb - 0.33) * 85);
    return Math.max(50, Math.min(98, conf));
}

/**
 * Calculate historical system win rates from ai_best_picks_history
 */
function calculateHistoricalStats(db) {
    const defaultStats = {
        ai_best_pick: { won: 0, lost: 0, winRate: '0.0' },
        safest: { won: 0, lost: 0, winRate: '0.0' },
        high_value: { won: 0, lost: 0, winRate: '0.0' }
    };

    if (!db) return defaultStats;

    try {
        const rows = db.prepare(`
            SELECT pick_type, status, COUNT(*) as count 
            FROM ai_best_picks_history 
            WHERE status IN ('won', 'lost')
            GROUP BY pick_type, status
        `).all();

        const data = {
            ai_best_pick: { won: 0, lost: 0 },
            safest: { won: 0, lost: 0 },
            high_value: { won: 0, lost: 0 }
        };

        rows.forEach(r => {
            if (data[r.pick_type]) {
                if (r.status === 'won') data[r.pick_type].won = r.count;
                if (r.status === 'lost') data[r.pick_type].lost = r.count;
            }
        });

        const computeWR = (item) => {
            const total = item.won + item.lost;
            return total > 0 ? ((item.won / total) * 100).toFixed(1) : '0.0';
        };

        return {
            ai_best_pick: { won: data.ai_best_pick.won, lost: data.ai_best_pick.lost, winRate: computeWR(data.ai_best_pick) },
            safest: { won: data.safest.won, lost: data.safest.lost, winRate: computeWR(data.safest) },
            high_value: { won: data.high_value.won, lost: data.high_value.lost, winRate: computeWR(data.high_value) }
        };
    } catch (_) {
        return defaultStats;
    }
}

/**
 * Calculate recent winning streak and recent wins
 */
function calculateRecentStreak(db) {
    if (!db) return { streak: 0, recentWins: [] };
    try {
        const picks = db.prepare(`
            SELECT id, round_number, pick_type, home_team, away_team, market, status, implied_odd, actual_score 
            FROM ai_best_picks_history 
            WHERE status IN ('won', 'lost') 
            ORDER BY id DESC LIMIT 25
        `).all();

        if (!picks || picks.length === 0) return { streak: 0, recentWins: [] };

        let streak = 0;
        const recentWins = [];
        for (const p of picks) {
            if (p.status === 'won') {
                streak++;
                if (recentWins.length < 5) {
                    recentWins.push({
                        match: `${p.home_team} vs ${p.away_team}`,
                        market: p.market,
                        odd: p.implied_odd || 1.5,
                        score: p.actual_score || 'FT'
                    });
                }
            } else {
                break;
            }
        }
        return { streak, recentWins };
    } catch (_) {
        return { streak: 0, recentWins: [] };
    }
}

/**
 * Calculate cumulative confidence win rate history for matches >= threshold
 */
function calculateConfidenceHistory(db, minConfidence) {
    try {
        const scoredMatches = db.prepare(`
            SELECT predicted_probs, confidence_score, actual_score, home_team, away_team 
            FROM live_predictions 
            WHERE scored_status = 1 AND actual_score IS NOT NULL
        `).all();

        let cumulativeWins = 0;
        let cumulativeLosses = 0;

        for (const p of scoredMatches) {
            const conf = calculateConfidenceForPrediction(p);
            if (conf < minConfidence) continue;

            const score = p.actual_score || '?:?';
            const [hG, aG] = score.split(':').map(Number);
            if (isNaN(hG) || isNaN(aG)) continue;

            let pr = p.predicted_probs || {};
            if (typeof pr === 'string') {
                try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; }
            }

            const hw = pr.homeWinProb || 0, dr = pr.drawProb || 0, aw = pr.awayWinProb || 0;
            const isGG = hG > 0 && aG > 0;
            const totG = hG + aG;

            const opts = [
                { label: `${p.home_team} Win`, prob: hw, type: 'home_win' },
                { label: `${p.away_team} Win`, prob: aw, type: 'away_win' },
                { label: 'Draw', prob: dr, type: 'draw' },
                { label: 'GG/BTTS', prob: pr.ggProb || 0, type: 'gg' },
                { label: 'Over 1.5', prob: pr.over15Prob || 0, type: 'over15' },
                { label: 'Over 2.5', prob: pr.over25Prob || 0, type: 'over25' },
            ];
            const best = opts.reduce((m, o) => o.prob > m.prob ? o : m, opts[0]);
            let isWin = false;
            switch (best.type) {
                case 'home_win': isWin = hG > aG; break;
                case 'away_win': isWin = aG > hG; break;
                case 'draw': isWin = hG === aG; break;
                case 'gg': isWin = isGG; break;
                case 'over15': isWin = totG >= 2; break;
                case 'over25': isWin = totG >= 3; break;
            }
            if (isWin) cumulativeWins++;
            else cumulativeLosses++;
        }

        const cumulativeTotal = cumulativeWins + cumulativeLosses;
        const cumulativeWinRate = cumulativeTotal > 0 ? ((cumulativeWins / cumulativeTotal) * 100).toFixed(1) : '0.0';
        return { cumulativeWins, cumulativeLosses, cumulativeWinRate, cumulativeTotal };
    } catch (_) {
        return { cumulativeWins: 0, cumulativeLosses: 0, cumulativeWinRate: '0.0', cumulativeTotal: 0 };
    }
}

/**
 * Helper to detect provider from database or path
 */
function detectProvider(dbOrPath, db) {
    const dbPathStr = typeof dbOrPath === 'string' ? dbOrPath : (db?.name || '');
    const isSporty = dbPathStr.toLowerCase().includes('sporty');
    const platformName = isSporty ? 'SportyBet VFL' : 'Bet9ja VFL';
    const provider = isSporty ? 'sportybet' : 'bet9ja';
    return { isSporty, platformName, provider };
}

/**
 * Sync settled match scores from sporty_fixtures / fixtures / ai_best_picks_history into live_predictions
 */
function syncSettledLivePredictions(db) {
    if (!db) return 0;
    let synced = 0;
    try {
        const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        const hasSportyFixtures = tableNames.includes('sporty_fixtures');
        const hasFixtures = tableNames.includes('fixtures');
        const hasAIPicks = tableNames.includes('ai_best_picks_history');

        const now = Date.now();
        const unscored = db.prepare(`
            SELECT id, season_name, round_number, home_team, away_team, kickoff_timestamp 
            FROM live_predictions 
            WHERE scored_status = 0 AND kickoff_timestamp IS NOT NULL AND kickoff_timestamp <= ?
            ORDER BY id DESC LIMIT 300
        `).all(now - 30 * 1000);

        if (unscored.length === 0) return 0;

        const updateLive = db.prepare(`
            UPDATE live_predictions 
            SET actual_score = ?, actual_ht_score = ?, scored_status = 1 
            WHERE id = ?
        `);

        for (const pred of unscored) {
            let ftScore = null;
            let htScore = '0:0';

            // 1. Check ai_best_picks_history
            if (hasAIPicks) {
                const pick = db.prepare(`
                    SELECT actual_score 
                    FROM ai_best_picks_history 
                    WHERE season_name = ? AND round_number = ? AND (home_team = ? OR away_team = ?) AND actual_score IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                `).get(pred.season_name, pred.round_number, pred.home_team, pred.away_team);
                if (pick && pick.actual_score) {
                    ftScore = pick.actual_score;
                }
            }

            // 2. Check sporty_fixtures
            if (!ftScore && hasSportyFixtures) {
                const fix = db.prepare(`
                    SELECT home_score, away_score, ht_home_score, ht_away_score 
                    FROM sporty_fixtures 
                    WHERE season_name = ? AND home_team = ? AND away_team = ? AND home_score IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                `).get(pred.season_name, pred.home_team, pred.away_team);
                if (fix && fix.home_score != null) {
                    ftScore = `${fix.home_score}:${fix.away_score}`;
                    htScore = `${fix.ht_home_score || 0}:${fix.ht_away_score || 0}`;
                }
            }

            // 3. Check fixtures
            if (!ftScore && hasFixtures) {
                const fix = db.prepare(`
                    SELECT home_score, away_score, ht_home_score, ht_away_score 
                    FROM fixtures 
                    WHERE season_name = ? AND home_team = ? AND away_team = ? AND home_score IS NOT NULL
                    ORDER BY id DESC LIMIT 1
                `).get(pred.season_name, pred.home_team, pred.away_team);
                if (fix && fix.home_score != null) {
                    ftScore = `${fix.home_score}:${fix.away_score}`;
                    htScore = `${fix.ht_home_score || 0}:${fix.ht_away_score || 0}`;
                }
            }

            if (ftScore) {
                updateLive.run(ftScore, htScore, pred.id);
                synced++;
            }
        }
    } catch (_) {}
    return synced;
}

/**
 * Clean season name for consistent deduplication key
 */
function cleanSeasonKey(seasonName, provider = 'sportybet') {
    if (!seasonName) return `${provider}_season`;
    return String(seasonName).toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Helper to extract round / week number and kickoff time
 */
function extractMatchMeta(item, fallbackRound = null, db = null) {
    if (!item) return { roundText: fallbackRound ? `Week ${fallbackRound}` : '', timeText: '' };
    const round = item.round_number || (item.match && item.match.round_number) || fallbackRound;
    const roundText = round ? `Week ${round}` : '';

    let time = item.match_time || (item.match && (item.match.match_time || item.match.matchTime)) || item.matchTime || null;
    let kickoffTs = item.kickoff_timestamp || (item.match && (item.match.kickoff_timestamp || item.match.kickoffMs)) || item.kickoffMs || null;

    let seasonTimeStr = null;
    if (item.season_name) {
        const m = String(item.season_name).match(/\((\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}))\)/);
        if (m) {
            seasonTimeStr = `${m[2]} WAT`;
        }
    }

    if ((!time && !kickoffTs) && db && item.home_team && item.away_team) {
        try {
            let row = null;
            if (item.id) {
                try {
                    row = db.prepare(`SELECT match_time, kickoff_timestamp FROM live_predictions WHERE id = ?`).get(item.id);
                } catch (_) {}
            }
            if (!row && item.season_name && round) {
                row = db.prepare(`
                    SELECT match_time, kickoff_timestamp 
                    FROM live_predictions 
                    WHERE home_team = ? AND away_team = ? AND season_name = ? AND round_number = ?
                    ORDER BY id DESC LIMIT 1
                `).get(item.home_team, item.away_team, item.season_name, round);
            }
            if (!row && item.season_name) {
                row = db.prepare(`
                    SELECT match_time, kickoff_timestamp 
                    FROM live_predictions 
                    WHERE home_team = ? AND away_team = ? AND season_name = ?
                    ORDER BY id DESC LIMIT 1
                `).get(item.home_team, item.away_team, item.season_name);
            }
            if (!row && round) {
                row = db.prepare(`
                    SELECT match_time, kickoff_timestamp 
                    FROM live_predictions 
                    WHERE home_team = ? AND away_team = ? AND round_number = ?
                    ORDER BY id DESC LIMIT 1
                `).get(item.home_team, item.away_team, round);
            }

            if (row) {
                if (row.kickoff_timestamp) kickoffTs = row.kickoff_timestamp;
                if (row.match_time) time = row.match_time;
            }
        } catch (_) {}
    }

    let timeText = '';
    if (kickoffTs) {
        timeText = formatWAT(kickoffTs);
    } else if (time) {
        timeText = formatWAT(time);
    } else if (seasonTimeStr) {
        timeText = seasonTimeStr;
    }

    return { roundText, timeText };
}

// ── REVAMPED BROADCAST TEMPLATES ──────────────────────────────────────────

/**
 * 1. Build Bundled Round AI Card ('ai_all')
 * Beautifully styled executive card with 3 signal tiers matching the official strategy playbook.
 */
function buildBundledAiCard(roundNumber, platformName, aiBest, safest, highValue, stats, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const anyPick = aiBest || safest || highValue;
    const roundMeta = extractMatchMeta(anyPick, roundNumber, db);
    const roundKickoff = roundMeta.timeText;
    const cleanPlatform = cleanPlatformTitle(platformName, anyPick?.season_name);

    let content = `💎 <b>${escapeHtml(config.channelTitle || 'NEXUS AI • PREDICTION SIGNALS')}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  ⚽ <b>Week ${roundNumber || 'Upcoming'}</b>\n`;
    content += `⏱️ Kickoff: <b>${escapeHtml(roundKickoff || 'Upcoming')}</b>  •  🕒 Posted: <b>${formatWAT()}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // 1. SAFEST PICK (Conservative / High hit rate)
    if (safest && safest.home_team && !safest.home_team.includes('Skipped')) {
        const prob = Math.round(safest.probability || 82);
        const oddVal = safest.implied_odd ? `@${safest.implied_odd}` : '-';

        content += `🛡️ <b>SAFEST PICK (HIGH STABILITY)</b>\n`;
        content += `⚽ <b>${escapeHtml(safest.home_team)} vs ${escapeHtml(safest.away_team)}</b>\n`;
        content += `🎯 <b>Selection:</b> <code>${escapeHtml(safest.market)}</code>\n`;
        content += `💰 <b>Odds:</b> <b>${oddVal}</b>  •  📊 <b>Model Prob:</b> <b>${prob}%</b>\n`;
        content += `🔥 <b>Confidence:</b> ${renderConfidenceBar(prob)}\n`;
        content += `💡 <i>Recommended stake: 4-5% bankroll (Target 80%+ win rate)</i>\n\n`;
    }

    // 2. HIGH VALUE PICK (Positive EV)
    if (highValue && highValue.home_team && !highValue.home_team.includes('Skipped')) {
        const prob = Math.round(highValue.probability || 65);
        const oddVal = highValue.implied_odd ? `@${highValue.implied_odd}` : '-';
        const evStr = highValue.ev_score ? `  •  📈 <b>Edge:</b> <code>+${Number(highValue.ev_score).toFixed(1)}% EV</code>` : '';

        content += `⚡ <b>HIGH VALUE PICK (POSITIVE EV)</b>\n`;
        content += `⚽ <b>${escapeHtml(highValue.home_team)} vs ${escapeHtml(highValue.away_team)}</b>\n`;
        content += `🎯 <b>Selection:</b> <code>${escapeHtml(highValue.market)}</code>\n`;
        content += `💰 <b>Odds:</b> <b>${oddVal}</b>  •  📊 <b>Model Prob:</b> <b>${prob}%</b>${evStr}\n`;
        content += `🔥 <b>Confidence:</b> ${renderConfidenceBar(prob)}\n`;
        content += `💡 <i>Recommended stake: 2-3% bankroll</i>\n\n`;
    }

    // 3. HIGH-RISK AI PICK (Burst ROI / Underdogs / HT-FT)
    if (aiBest && aiBest.home_team && !aiBest.home_team.includes('Skipped')) {
        const prob = Math.round(aiBest.probability || 45);
        const oddVal = aiBest.implied_odd ? `@${aiBest.implied_odd}` : '-';
        const oppTip = getOppositeMarketTip(aiBest.market);

        content += `🤖 <b>HIGH-RISK AI PICK (BURST ROI)</b>\n`;
        content += `⚽ <b>${escapeHtml(aiBest.home_team)} vs ${escapeHtml(aiBest.away_team)}</b>\n`;
        content += `🎯 <b>Selection:</b> <code>${escapeHtml(aiBest.market)}</code>\n`;
        content += `💰 <b>Odds:</b> <b>${oddVal}</b>  •  📊 <b>Model Prob:</b> <b>${prob}%</b>\n`;
        content += `🔥 <b>Confidence:</b> ${renderConfidenceBar(prob)}\n`;
        if (oppTip) {
            content += `🔄 <i>Hedge Option: ${escapeHtml(oppTip)}</i>\n`;
        }
        content += `💡 <i>Recommended stake: 0.5-1% small change only</i>\n\n`;
    }

    // System Win Rates Footer
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `📊 <b>VERIFIED HISTORICAL HIT RATES</b>\n`;
    content += `🛡️ Safest: <b>${stats.safest.winRate}%</b> (${stats.safest.won}W/${stats.safest.lost}L)\n`;
    content += `⚡ Value: <b>${stats.high_value.winRate}%</b> (${stats.high_value.won}W/${stats.high_value.lost}L)\n`;
    content += `🤖 AI Pick: <b>${stats.ai_best_pick.winRate}%</b> (${stats.ai_best_pick.won}W/${stats.ai_best_pick.lost}L)\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;

    return content;
}

/**
 * 2. Build Single AI Pick Card ('ai_only' | 'safest' | 'high_value')
 */
function buildSingleAiPickCard(pick, platformName, stats, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const isHighRisk = pick.pick_type === 'ai_best_pick';
    const isSafest = pick.pick_type === 'safest';

    const header = isHighRisk 
        ? '🤖 HIGH-RISK AI PICK (BURST ROI)' 
        : isSafest 
            ? '🛡️ SAFEST PICK (HIGH STABILITY)' 
            : '⚡ HIGH VALUE PICK (POSITIVE EV)';

    const pickStat = isHighRisk ? stats.ai_best_pick : isSafest ? stats.safest : stats.high_value;
    const statLabel = isHighRisk ? 'High-Risk AI Pick' : isSafest ? 'Safest Pick' : 'High Value Pick';
    const meta = extractMatchMeta(pick, pick.round_number, db);
    const cleanPlatform = cleanPlatformTitle(platformName, pick.season_name);
    const prob = Math.round(pick.probability || 60);
    const oddVal = pick.implied_odd ? `@${pick.implied_odd}` : '-';

    let content = `💎 <b>${escapeHtml(config.channelTitle || 'NEXUS VIP SIGNAL')}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  ⚽ <b>${meta.roundText || 'Upcoming Round'}</b>\n`;
    if (meta.timeText) content += `⏱️ Kickoff: <b>${escapeHtml(meta.timeText)}</b>  •  `;
    content += `🕒 Posted: <b>${formatWAT()}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    content += `<b>${header}</b>\n`;
    content += `⚽ <b>${escapeHtml(pick.home_team)} vs ${escapeHtml(pick.away_team)}</b>\n`;
    content += `🎯 <b>Selection:</b> <code>${escapeHtml(pick.market)}</code>\n`;
    content += `💰 <b>Odds:</b> <b>${oddVal}</b>  •  📊 <b>Model Prob:</b> <b>${prob}%</b>\n`;
    content += `🔥 <b>Confidence:</b> ${renderConfidenceBar(prob)}\n`;

    if (isHighRisk) {
        const oppTip = getOppositeMarketTip(pick.market);
        if (oppTip) {
            content += `🔄 <i>Hedge Option: ${escapeHtml(oppTip)}</i>\n`;
        }
    }

    content += `\n📈 <b>Verified ${statLabel} Win Rate:</b> <b>${pickStat.winRate}%</b> (${pickStat.won}W / ${pickStat.lost}L)\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;

    return content;
}

/**
 * 3. Build Upcoming Fixtures Card ('all' mode)
 */
function buildUpcomingFixturesCard(roundNumber, seasonName, platformName, matches, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const firstMatch = matches[0];
    const roundMeta = extractMatchMeta(firstMatch, roundNumber, db);
    const roundKickoff = roundMeta.timeText;
    const cleanPlatform = cleanPlatformTitle(platformName, seasonName);

    let content = `⚡ <b>${escapeHtml(config.channelTitle || 'NEXUS AI • MATCH SCHEDULE')}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `📅 <b>${escapeHtml(cleanPlatform)} — Week ${roundNumber}</b>\n`;
    content += `⏱️ Kickoff: <b>${escapeHtml(roundKickoff || 'Upcoming')}</b>  •  🕒 <b>${formatWAT()}</b>\n`;
    content += `📋 <b>${matches.length} matches scheduled</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    matches.slice(0, 10).forEach(p => {
        let pr = p.predicted_probs || {};
        if (typeof pr === 'string') {
            try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; }
        }
        const hw = pr.homeWinProb || 0;
        const dr = pr.drawProb || 0;
        const aw = pr.awayWinProb || 0;
        const conf = calculateConfidenceForPrediction(p);

        const opts = [
            { label: `${p.home_team} Win`, prob: hw },
            { label: `${p.away_team} Win`, prob: aw },
            { label: 'Draw', prob: dr },
            { label: 'GG / BTTS', prob: pr.ggProb || 0 },
            { label: 'Over 1.5', prob: pr.over15Prob || 0 },
            { label: 'Over 2.5', prob: pr.over25Prob || 0 }
        ];
        const best = opts.reduce((m, o) => o.prob > m.prob ? o : m, opts[0]);

        content += `⚽ <b>${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</b>\n`;
        content += `   🎯 Best Bet: <code>${escapeHtml(best.label)}</code> (${best.prob}%)\n`;
        content += `   🔥 Confidence: ${renderConfidenceBar(conf)}  •  1X2: <code>${hw}%/${dr}%/${aw}%</code>\n\n`;
    });

    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;
    return content;
}

/**
 * 4. Build Filtered Confidence Picks Card ('confidence_filtered')
 */
function buildConfidenceFilteredCard(roundNumber, seasonName, platformName, matches, minConfidence, histStats, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const firstMatch = matches[0];
    const roundMeta = extractMatchMeta(firstMatch, roundNumber, db);
    const roundKickoff = roundMeta.timeText;
    const cleanPlatform = cleanPlatformTitle(platformName, seasonName);

    let content = `⚡ <b>HIGH CONFIDENCE SIGNALS (≥${minConfidence}%)</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)} | Week ${roundNumber}</b>\n`;
    content += `⏱️ Kickoff: <b>${escapeHtml(roundKickoff || 'Upcoming')}</b>  •  📋 <b>${matches.length} qualifying match${matches.length !== 1 ? 'es' : ''}</b>\n`;
    content += `📊 <b>Historical Hit Rate (≥${minConfidence}%):</b> <b>${histStats.cumulativeWinRate}%</b> (${histStats.cumulativeWins}W / ${histStats.cumulativeLosses}L)\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    matches.forEach(p => {
        let pr = p.predicted_probs || {};
        if (typeof pr === 'string') {
            try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; }
        }
        const hw = pr.homeWinProb || 0, dr = pr.drawProb || 0, aw = pr.awayWinProb || 0;
        const conf = calculateConfidenceForPrediction(p);
        const opts = [
            { label: `${p.home_team} Win`, prob: hw },
            { label: `${p.away_team} Win`, prob: aw },
            { label: 'Draw', prob: dr },
            { label: 'GG / BTTS', prob: pr.ggProb || 0 },
            { label: 'Over 1.5 Goals', prob: pr.over15Prob || 0 },
            { label: 'Over 2.5 Goals', prob: pr.over25Prob || 0 },
        ];
        const best = opts.reduce((m, o) => o.prob > m.prob ? o : m, opts[0]);

        content += `⚽ <b>${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</b>\n`;
        content += `   🎯 <b>Top Bet:</b> <code>${escapeHtml(best.label)}</code> (${best.prob}%)\n`;
        content += `   🔥 <b>Confidence:</b> ${renderConfidenceBar(conf)}  •  1X2: <code>${hw}%/${dr}%/${aw}%</code>\n\n`;
    });

    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;
    return content;
}

/**
 * 5. Build Filtered Confidence Results Card
 */
function buildConfidenceFilteredResultsCard(roundNumber, seasonName, platformName, matches, minConfidence, histStats, accuracy, correctCount, totalCount, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const accuracyIcon = parseFloat(accuracy) >= 60 ? '🟢' : parseFloat(accuracy) >= 40 ? '🟡' : '🔴';
    const cleanPlatform = cleanPlatformTitle(platformName, seasonName);

    let content = `🏆 <b>HIGH CONFIDENCE RESULTS (WEEK ${roundNumber})</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  🕒 Settled: <b>${formatWAT()}</b>\n`;
    content += `📊 <b>Round Hit Rate:</b> <b>${correctCount}/${totalCount} WON (${accuracy}%)</b> ${accuracyIcon}\n`;
    content += `📈 <b>Cumulative Hit Rate (≥${minConfidence}%):</b> <b>${histStats.cumulativeWinRate}%</b> (${histStats.cumulativeWins}W / ${histStats.cumulativeLosses}L)\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    matches.forEach(p => {
        let pr = p.predicted_probs || {};
        if (typeof pr === 'string') {
            try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; }
        }
        const hw = pr.homeWinProb || 0, dr = pr.drawProb || 0, aw = pr.awayWinProb || 0;
        const score = p.actual_score || '?:?';
        const [hG, aG] = score.split(':').map(Number);
        let actualRes = 'Draw';
        if (!isNaN(hG) && !isNaN(aG)) {
            if (hG > aG) actualRes = 'Home Win';
            else if (aG > hG) actualRes = 'Away Win';
        }

        const opts = [
            { label: `${p.home_team} Win`, prob: hw, type: 'home_win' },
            { label: `${p.away_team} Win`, prob: aw, type: 'away_win' },
            { label: 'Draw', prob: dr, type: 'draw' },
            { label: 'GG / BTTS', prob: pr.ggProb || 0, type: 'gg' },
            { label: 'Over 1.5 Goals', prob: pr.over15Prob || 0, type: 'over15' },
            { label: 'Over 2.5 Goals', prob: pr.over25Prob || 0, type: 'over25' },
        ];
        const best = opts.reduce((m, o) => o.prob > m.prob ? o : m, opts[0]);

        let isWin = false;
        if (!isNaN(hG) && !isNaN(aG)) {
            const totG = hG + aG;
            const isGG = hG > 0 && aG > 0;
            switch (best.type) {
                case 'home_win': isWin = hG > aG; break;
                case 'away_win': isWin = aG > hG; break;
                case 'draw': isWin = hG === aG; break;
                case 'gg': isWin = isGG; break;
                case 'over15': isWin = totG >= 2; break;
                case 'over25': isWin = totG >= 3; break;
            }
        }
        const icon = isWin ? '✅' : '❌';
        const scoreStr = !isNaN(hG) && !isNaN(aG) ? `${p.home_team} ${hG} - ${aG} ${p.away_team}` : `${p.home_team} vs ${p.away_team}`;

        content += `${icon} <b>${escapeHtml(scoreStr)}</b>\n`;
        content += `   🎯 Tip: <code>${escapeHtml(best.label)}</code> (${best.prob}%)\n`;
        content += `   🏁 Outcome: <b>${isWin ? 'WON 💥' : 'LOST'}</b>  •  FT: <code>${score}</code>\n\n`;
    });

    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;
    return content;
}

/**
 * 6. Build Round Scored Results Card (AI picks)
 * Shows each bet with won/lost badge, return units, round profit, and winning streak!
 */
function buildRoundResultsCard(roundNumber, seasonName, platformName, results, accuracy, correctCount, totalCount, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const cleanPlatform = cleanPlatformTitle(platformName, seasonName);
    const streakInfo = calculateRecentStreak(db);

    // Calculate net units profit/loss for this round
    let netUnits = 0;
    results.forEach(r => {
        if (r.status === 'won') {
            const odd = Number(r.implied_odd) || 1.5;
            netUnits += odd - 1.0;
        } else if (r.status === 'lost') {
            netUnits -= 1.0;
        }
    });

    const isProfit = netUnits >= 0;
    const netFormatted = (isProfit ? '+' : '') + netUnits.toFixed(2) + 'u';
    let roundStatusBadge = '🟢 PROFITABLE ROUND';
    if (correctCount === totalCount && totalCount > 0) {
        roundStatusBadge = '🔥 PERFECT ROUND (100% CLEAN SWEEP!) 💥';
    } else if (correctCount === 0 && totalCount > 0) {
        roundStatusBadge = '🔴 DRAWDOWN ROUND';
    } else if (correctCount >= totalCount / 2) {
        roundStatusBadge = '🟢 PROFITABLE ROUND';
    } else {
        roundStatusBadge = '🟡 BALANCED ROUND';
    }

    let content = `🏆 <b>WEEK ${roundNumber} SETTLED RESULTS</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  🕒 Settled: <b>${formatWAT()}</b>\n`;
    content += `📊 <b>Round Score:</b> <b>${correctCount} / ${totalCount} WON (${accuracy}%)</b>\n`;
    content += `🎯 <b>${roundStatusBadge}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    results.forEach(r => {
        const isWon = r.status === 'won';
        const icon = isWon ? '✅' : '❌';
        const oddVal = Number(r.implied_odd) || 1.5;
        const oddText = r.implied_odd ? ` @${r.implied_odd}` : '';
        const returnText = isWon ? `WON (+${(oddVal - 1.0).toFixed(2)}u) 💥` : `LOST (-1.00u)`;

        let scoreStr = `${r.home_team} vs ${r.away_team}`;
        if (r.actual_score && r.actual_score.includes(':')) {
            const [hG, aG] = r.actual_score.split(':');
            scoreStr = `${r.home_team} ${hG} - ${aG} ${r.away_team}`;
        }

        const tierLabel = r.pick_type === 'safest' ? 'Safest' : r.pick_type === 'high_value' ? 'High Value' : 'High-Risk AI';

        content += `${icon} <b>${escapeHtml(scoreStr)}</b>\n`;
        content += `   🎯 Tip: <code>${escapeHtml(r.market)}</code>${oddText} (${tierLabel})\n`;
        content += `   💵 Outcome: <b>${returnText}</b>\n\n`;
    });

    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `💰 <b>Net Round Return:</b> <b>${netFormatted}${isProfit && netUnits > 0 ? ' PROFIT 🚀' : ''}</b>\n`;
    if (streakInfo.streak >= 2) {
        content += `🔥 <b>Current Win Streak:</b> <b>${streakInfo.streak} WINS IN A ROW! 🚀</b>\n`;
    }
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🎯 <i>Next round AI picks are generating now...</i>`;

    return content;
}

/**
 * 7. Build Round Completed Fixtures Results Card ('all' mode)
 */
function buildFixturesResultsCard(roundNumber, seasonName, platformName, matches, db = null, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const cleanPlatform = cleanPlatformTitle(platformName, seasonName);

    let content = `🏆 <b>WEEK ${roundNumber} MATCH SCORES</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `📅 <b>${escapeHtml(cleanPlatform)}</b>  •  🕒 Settled: <b>${formatWAT()}</b>\n`;
    content += `📋 <b>${matches.length} match${matches.length !== 1 ? 'es' : ''} settled</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    matches.slice(0, 10).forEach(m => {
        const score = m.actual_score || '-';
        const [h, a] = score.includes(':') ? score.split(':').map(Number) : [-1, -1];
        let outcome = '';
        if (h > a) outcome = '🟢 (Home Win)';
        else if (a > h) outcome = '🔵 (Away Win)';
        else if (h === a && h >= 0) outcome = '🟡 (Draw)';

        content += `⚽ <b>${escapeHtml(m.home_team)} ${score} ${escapeHtml(m.away_team)}</b> ${outcome}\n`;
    });

    content += `\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += config.footer || DEFAULT_FOOTER;
    return content;
}

/**
 * 8. Build Streak Celebration Card
 */
function buildStreakCelebrationCard(streakCount, recentWins = [], platformName = 'SportyBet VFL', customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const cleanPlatform = cleanPlatformTitle(platformName);

    let content = `🔥 <b>UNSTOPPABLE WINNING STREAK!</b> 🔥\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🚀 <b>${streakCount} CONSECUTIVE SIGNALS WON!</b>\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  🕒 <b>${formatWAT()}</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    content += `🎯 <b>Recent Winning Signals:</b>\n`;
    recentWins.forEach((w, i) => {
        content += `  ${i + 1}. ✅ <b>${escapeHtml(w.match)}</b> — <code>${escapeHtml(w.market)}</code> (@${w.odd || '1.50'})\n`;
    });

    content += `\n💰 <b>Profit Momentum:</b> Algorithm is running at peak walk-forward precision!\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `👑 <i>Lock in profits & adhere to strict bankroll allocation! 18+</i>`;

    return content;
}

/**
 * 9. Build Daily Performance Report
 */
function buildDailyPerformanceReport(db, platformName = 'SportyBet VFL', customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const cleanPlatform = cleanPlatformTitle(platformName);

    let stats = { total: 0, won: 0, lost: 0, net_units: 0 };
    if (db) {
        try {
            const row = db.prepare(`
                SELECT 
                    COUNT(*) as total, 
                    SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won, 
                    SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost, 
                    ROUND(SUM(CASE WHEN status = 'won' THEN COALESCE(implied_odd, 1.5) - 1.0 ELSE -1.0 END), 2) as net_units 
                FROM ai_best_picks_history 
                WHERE status IN ('won', 'lost')
            `).get();
            if (row) stats = row;
        } catch (_) {}
    }

    const wr = stats.total > 0 ? ((stats.won / stats.total) * 100).toFixed(1) : '0.0';
    const isProfit = (stats.net_units || 0) >= 0;
    const netStr = (isProfit ? '+' : '') + (stats.net_units || 0).toFixed(2) + ' Units';

    let content = `📊 <b>DAILY PERFORMANCE DIGEST</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🏆 <b>${escapeHtml(cleanPlatform)}</b>  •  📅 <b>Today's Record</b>\n`;
    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    content += `🎯 <b>Total Tips Settled:</b> <b>${stats.total}</b>\n`;
    content += `✅ <b>Won:</b> <b>${stats.won}</b>  |  ❌ <b>Lost:</b> <b>${stats.lost}</b>\n`;
    content += `📈 <b>Overall Hit Rate:</b> <b>${wr}%</b>\n`;
    content += `💰 <b>Net Units:</b> <b>${netStr}${isProfit ? ' 🚀' : ''}</b>\n\n`;

    content += `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `👑 <b>Nexus AI Engine — Walk-Forward Verified Analytics</b>\n`;
    content += config.footer || DEFAULT_FOOTER;

    return content;
}

// ── MAIN BROADCAST ENGINE ──────────────────────────────────────────────────

/**
 * Deliver a message to primary channel and/or VIP group and active subscribers
 */
async function broadcastMessage(text, config, db, dedupKey, msgType = 'broadcast') {
    if(config.feedStyle==='curated')return {success:true,duplicate:true,skipped:true,reason:'Compact feed suppresses legacy card streams'};
    if (!text || !config.botToken || !config.chatId) {
        return { success: false, error: 'Telegram credentials missing' };
    }

    if (dedupKey && isKeySent(db, dedupKey)) {
        return { success: true, duplicate: true };
    }

    const target = config.targetChannel || 'main';
    const primaryRes = await sendRawTelegramMessage(config.botToken, config.chatId, text);

    if (!primaryRes.ok) {
        console.error(`[Telegram Broadcaster] ❌ Failed to send to ${config.chatId}:`, primaryRes.description);
        return { success: false, error: primaryRes.description };
    }

    console.log(`[Telegram Broadcaster] ✅ Sent successfully to ${config.chatId}! (Msg ID: ${primaryRes.result?.message_id})`);

    // Also send to VIP Group if configured and target is 'both' or 'vip'
    if (config.vipGroupId && (target === 'both' || target === 'vip')) {
        try {
            await sendRawTelegramMessage(config.botToken, config.vipGroupId, text);
        } catch (_) {}
    }

    // Mark as sent in DB
    if (dedupKey) {
        markKeySent(db, dedupKey, msgType);
    }

    // Deliver to active VIP Subscribers via Private DM
    const activeVips = (config.subscribers || []).filter(s => {
        if (s.status !== 'active' || !s.chatId) return false;
        if (!s.expiryDate) return true;
        return new Date(s.expiryDate).getTime() > Date.now();
    });

    if (activeVips.length > 0) {
        for (const sub of activeVips) {
            try {
                await sendRawTelegramMessage(config.botToken, sub.chatId, text);
            } catch (_) {}
        }
    }

    return { success: true, messageId: primaryRes.result?.message_id };
}

/**
 * Broadcast confidence-filtered upcoming predictions
 */
async function broadcastConfidencePredictions(dbOrPath, customConfig = {}, force = false) {
    const config = loadTelegramSettings(customConfig);
    if(config.feedStyle==='curated')return {success:true,sentCount:0,skipped:true,reason:'Compact feed uses qualified signals only'};
    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return { success: false, error };

    ensureTelegramLogTable(db);
    const { platformName, provider } = detectProvider(dbOrPath, db);
    const minConf = config.confidenceFilter || 50;

    const results = [];
    try {
        const upcomingMatches = db.prepare(`
            SELECT * FROM live_predictions 
            WHERE scored_status = 0 
              AND home_team IS NOT NULL 
              AND away_team IS NOT NULL
            ORDER BY round_number ASC, id ASC
        `).all();

        if (upcomingMatches.length === 0) {
            if (shouldClose) db.close();
            return { success: true, sentCount: 0, message: 'No upcoming matches found' };
        }

        const filteredMatches = upcomingMatches.filter(p => calculateConfidenceForPrediction(p) >= minConf);
        if (filteredMatches.length === 0) {
            if (shouldClose) db.close();
            return { success: true, sentCount: 0, message: `No upcoming matches meet ≥${minConf}% confidence` };
        }

        const histStats = calculateConfidenceHistory(db, minConf);
        
        const groups = [];
        const seenGroupKeys = new Set();
        for (const m of filteredMatches) {
            const gKey = `${m.season_name || 'season'}_w${m.round_number || 0}`;
            if (!seenGroupKeys.has(gKey)) {
                seenGroupKeys.add(gKey);
                groups.push({ season_name: m.season_name, round_number: m.round_number });
            }
        }

        for (const group of groups) {
            const roundNum = group.round_number;
            const roundMatches = filteredMatches.filter(m => m.season_name === group.season_name && m.round_number === roundNum);
            if (roundMatches.length === 0) continue;

            const firstMatch = roundMatches[0];
            const seasonKey = cleanSeasonKey(firstMatch.season_name, provider);
            const dedupKey = `conf_round_${seasonKey}_w${roundNum}_c${minConf}`;

            if (!force && isKeySent(db, dedupKey)) continue;

            if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                markKeySent(db, dedupKey, 'conf_skipped_frequency');
                continue;
            }

            const msg = buildConfidenceFilteredCard(roundNum, firstMatch.season_name, platformName, roundMatches, minConf, histStats, db, config);
            const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'confidence_filtered_picks');
            if (sendRes.success && !sendRes.duplicate) {
                results.push({ round: roundNum, type: 'confidence_picks', count: roundMatches.length, messageId: sendRes.messageId });
            }
        }
    } catch (err) {
        console.error('[Telegram Broadcaster] Error in broadcastConfidencePredictions:', err.message);
        if (shouldClose) db.close();
        return { success: false, error: err.message };
    }

    if (shouldClose) db.close();
    return { success: true, sentCount: results.length, results };
}

/**
 * Broadcast confidence-filtered scored results
 */
async function broadcastConfidenceResults(dbOrPath, customConfig = {}, force = false) {
    const config = loadTelegramSettings(customConfig);
    if(config.feedStyle==='curated')return {success:true,sentCount:0,skipped:true,reason:'Compact feed uses qualified signals only'};
    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return { success: false, error };

    ensureTelegramLogTable(db);
    const { platformName, provider } = detectProvider(dbOrPath, db);
    const minConf = config.confidenceFilter || 50;

    const results = [];
    try {
        const scoredMatches = db.prepare(`
            SELECT * FROM live_predictions 
            WHERE scored_status = 1 
              AND actual_score IS NOT NULL 
              AND home_team IS NOT NULL 
              AND away_team IS NOT NULL
            ORDER BY id DESC LIMIT 100
        `).all();

        if (scoredMatches.length === 0) {
            if (shouldClose) db.close();
            return { success: true, sentCount: 0 };
        }

        const filteredScored = scoredMatches.filter(p => calculateConfidenceForPrediction(p) >= minConf);
        if (filteredScored.length === 0) {
            if (shouldClose) db.close();
            return { success: true, sentCount: 0 };
        }

        const histStats = calculateConfidenceHistory(db, minConf);
        
        const groups = [];
        const seenGroupKeys = new Set();
        for (const m of filteredScored) {
            const gKey = `${m.season_name || 'season'}_w${m.round_number || 0}`;
            if (!seenGroupKeys.has(gKey)) {
                seenGroupKeys.add(gKey);
                groups.push({ season_name: m.season_name, round_number: m.round_number });
            }
        }

        for (const group of groups) {
            const roundNum = group.round_number;
            const roundMatches = filteredScored.filter(m => m.season_name === group.season_name && m.round_number === roundNum);
            if (roundMatches.length === 0) continue;

            const firstMatch = roundMatches[0];
            const seasonKey = cleanSeasonKey(firstMatch.season_name, provider);
            const dedupKey = `conf_results_round_${seasonKey}_w${roundNum}_c${minConf}`;

            if (!force && isKeySent(db, dedupKey)) continue;

            if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                markKeySent(db, dedupKey, 'conf_results_skipped_frequency');
                continue;
            }

            let correct = 0;
            for (const p of roundMatches) {
                const score = p.actual_score || '?:?';
                const [hG, aG] = score.split(':').map(Number);
                if (isNaN(hG) || isNaN(aG)) continue;
                let pr = p.predicted_probs || {};
                if (typeof pr === 'string') { try { pr = JSON.parse(pr) || {}; } catch (_) { pr = {}; } }
                const hw = pr.homeWinProb || 0, dr = pr.drawProb || 0, aw = pr.awayWinProb || 0;
                const opts = [
                    { label: 'hw', type: 'home_win', prob: hw },
                    { label: 'aw', type: 'away_win', prob: aw },
                    { label: 'dr', type: 'draw', prob: dr },
                    { label: 'gg', type: 'gg', prob: pr.ggProb || 0 },
                    { label: 'o15', type: 'over15', prob: pr.over15Prob || 0 },
                    { label: 'o25', type: 'over25', prob: pr.over25Prob || 0 },
                ];
                const best = opts.reduce((m, o) => o.prob > m.prob ? o : m, opts[0]);
                const isGG = hG > 0 && aG > 0;
                const totG = hG + aG;
                let win = false;
                switch (best.type) {
                    case 'home_win': win = hG > aG; break;
                    case 'away_win': win = aG > hG; break;
                    case 'draw': win = hG === aG; break;
                    case 'gg': win = isGG; break;
                    case 'over15': win = totG >= 2; break;
                    case 'over25': win = totG >= 3; break;
                }
                if (win) correct++;
            }

            const total = roundMatches.length;
            const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';

            const msg = buildConfidenceFilteredResultsCard(roundNum, firstMatch.season_name, platformName, roundMatches, minConf, histStats, accuracy, correct, total, db, config);
            const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'confidence_filtered_results');
            if (sendRes.success && !sendRes.duplicate) {
                results.push({ round: roundNum, type: 'confidence_results', won: correct, total, messageId: sendRes.messageId });
            }
        }
    } catch (err) {
        console.error('[Telegram Broadcaster] Error in broadcastConfidenceResults:', err.message);
        if (shouldClose) db.close();
        return { success: false, error: err.message };
    }

    if (shouldClose) db.close();
    return { success: true, sentCount: results.length, results };
}

/**
 * Scan database for unsent predictions and broadcast them
 */
async function broadcastPendingPredictions(dbOrPath, customConfig = {}, force = false) {
    const config = loadTelegramSettings(customConfig);
    if (!config.autoPost && !force) {
        return { success: false, skipped: true, reason: 'autoPostToTelegram is disabled' };
    }

    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return { success: false, error };

    ensureTelegramLogTable(db);
    const { platformName, provider } = detectProvider(dbOrPath, db);

    if(config.feedStyle==='curated') {
        try {
            const result=await require('./telegram_curated_feed').pending(db,{...config,provider});
            if(result.sentCount)markKeySent(db,`curated_${provider}_${Date.now()}`,'curated_signal');
            return result;
        } finally {if(shouldClose)db.close();}
    }

    const stats = calculateHistoricalStats(db);
    const results = [];

    try {
        // 1. Broadcast Confidence Filtered Signals if enabled
        if (config.autoSendConfidencePicks || config.broadcastMode === 'confidence_filtered' || config.broadcastMode === 'confidence') {
            const confRes = await broadcastConfidencePredictions(db, config, force);
            if (confRes.results && confRes.results.length > 0) {
                results.push(...confRes.results);
            }
        }

        // 2. Broadcast according to broadcastMode
        if (config.broadcastMode === 'all') {
            const upcomingMatches = db.prepare(`
                SELECT * FROM live_predictions 
                WHERE scored_status = 0 
                  AND home_team IS NOT NULL 
                  AND away_team IS NOT NULL
                ORDER BY round_number ASC, id ASC
            `).all();

            const groups = [];
            const seenGroupKeys = new Set();
            for (const m of upcomingMatches) {
                const gKey = `${m.season_name || 'season'}_w${m.round_number || 0}`;
                if (!seenGroupKeys.has(gKey)) {
                    seenGroupKeys.add(gKey);
                    groups.push({ season_name: m.season_name, round_number: m.round_number });
                }
            }

            for (const group of groups) {
                const roundNum = group.round_number;
                const roundMatches = upcomingMatches.filter(m => m.season_name === group.season_name && m.round_number === roundNum);
                if (roundMatches.length === 0) continue;

                const firstMatch = roundMatches[0];
                const seasonKey = cleanSeasonKey(firstMatch.season_name, provider);
                const dedupKey = `fixtures_${seasonKey}_w${roundNum}`;

                if (!force && isKeySent(db, dedupKey)) continue;

                if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                    markKeySent(db, dedupKey, 'fixtures_skipped_frequency');
                    continue;
                }

                const msg = buildUpcomingFixturesCard(roundNum, firstMatch.season_name, platformName, roundMatches, db, config);
                const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'upcoming_fixtures');
                if (sendRes.success && !sendRes.duplicate) {
                    results.push({ round: roundNum, type: 'fixtures', messageId: sendRes.messageId });
                }
            }

        } else if (config.broadcastMode === 'ai_all') {
            // Mode: Bundled All AI Picks (Safest + High Value + High-Risk AI)
            const rawPicks = db.prepare(`
                SELECT a.*, 
                       lp.kickoff_timestamp AS lp_kickoff_timestamp, 
                       lp.match_time AS lp_match_time
                FROM ai_best_picks_history a
                LEFT JOIN live_predictions lp 
                  ON lp.home_team = a.home_team 
                 AND lp.away_team = a.away_team 
                 AND lp.season_name = a.season_name 
                 AND lp.round_number = a.round_number
                WHERE a.status = 'pending' 
                  AND a.home_team NOT LIKE 'Skipped%'
                ORDER BY a.round_number ASC, a.id ASC
            `).all();
            const pendingPicks = require('./strategy_release').filterValidatedPicks(require('./pick_policy').filterPublishablePicks(rawPicks.map(p => ({
                ...p,
                kickoff_timestamp: p.kickoff_timestamp || p.lp_kickoff_timestamp || null,
                match_time: p.match_time || p.lp_match_time || null
            }))));

            const groups = [];
            const seenGroupKeys = new Set();
            for (const p of pendingPicks) {
                const gKey = `${p.season_name || 'season'}_w${p.round_number || 0}`;
                if (!seenGroupKeys.has(gKey)) {
                    seenGroupKeys.add(gKey);
                    groups.push({ season_name: p.season_name, round_number: p.round_number });
                }
            }

            for (const group of groups) {
                const roundNum = group.round_number;
                const roundPicks = pendingPicks.filter(p => p.season_name === group.season_name && p.round_number === roundNum);
                const aiBest = roundPicks.find(p => p.pick_type === 'ai_best_pick');
                const safest = roundPicks.find(p => p.pick_type === 'safest');
                const highValue = roundPicks.find(p => p.pick_type === 'high_value');

                if (!aiBest && !safest && !highValue) continue;

                const seasonName = roundPicks[0]?.season_name;
                const seasonKey = cleanSeasonKey(seasonName, provider);
                const dedupKey = `ai_bundle_${seasonKey}_w${roundNum}`;

                if (!force && isKeySent(db, dedupKey)) continue;

                if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                    markKeySent(db, dedupKey, 'ai_bundle_skipped_frequency');
                    continue;
                }

                const msg = buildBundledAiCard(roundNum, platformName, aiBest, safest, highValue, stats, db, config);
                const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'ai_bundle');
                if (sendRes.success && !sendRes.duplicate) {
                    results.push({ round: roundNum, type: 'ai_bundle', messageId: sendRes.messageId });
                }
            }

        } else if (['ai_only', 'safest', 'high_value'].includes(config.broadcastMode)) {
            const targetType = config.broadcastMode === 'ai_only' 
                ? 'ai_best_pick' 
                : config.broadcastMode === 'safest' 
                    ? 'safest' 
                    : 'high_value';

            const rawPicks = db.prepare(`
                SELECT a.*, 
                       lp.kickoff_timestamp AS lp_kickoff_timestamp, 
                       lp.match_time AS lp_match_time
                FROM ai_best_picks_history a
                LEFT JOIN live_predictions lp 
                  ON lp.home_team = a.home_team 
                 AND lp.away_team = a.away_team 
                 AND lp.season_name = a.season_name 
                 AND lp.round_number = a.round_number
                WHERE a.status = 'pending' 
                  AND a.pick_type = ? 
                  AND a.home_team NOT LIKE 'Skipped%'
                ORDER BY a.round_number ASC, a.id ASC
            `).all(targetType);
            const pendingPicks = require('./strategy_release').filterValidatedPicks(require('./pick_policy').filterPublishablePicks(rawPicks.map(p => ({
                ...p,
                kickoff_timestamp: p.kickoff_timestamp || p.lp_kickoff_timestamp || null,
                match_time: p.match_time || p.lp_match_time || null
            }))));

            for (const pick of pendingPicks) {
                const seasonKey = cleanSeasonKey(pick.season_name, provider);
                const dedupKey = `ai_single_${seasonKey}_w${pick.round_number}_${targetType}`;

                if (!force && isKeySent(db, dedupKey)) continue;

                if (!force && config.broadcastFrequency > 1 && (pick.round_number % config.broadcastFrequency !== 0)) {
                    markKeySent(db, dedupKey, 'ai_single_skipped_frequency');
                    continue;
                }

                const msg = buildSingleAiPickCard(pick, platformName, stats, db, config);
                const sendRes = await broadcastMessage(msg, config, db, dedupKey, `ai_single_${targetType}`);
                if (sendRes.success && !sendRes.duplicate) {
                    results.push({ round: pick.round_number, pickId: pick.id, type: targetType, messageId: sendRes.messageId });
                }
            }
        }

    } catch (err) {
        console.error('[Telegram Broadcaster] Error in broadcastPendingPredictions:', err.message);
        if (shouldClose) db.close();
        return { success: false, error: err.message };
    }

    if (shouldClose) db.close();
    return {
        success: true,
        sentCount: results.length,
        results
    };
}

/**
 * Scan database for newly settled AI picks or match fixtures and broadcast results
 */
async function broadcastSettledResults(dbOrPath, customConfig = {}, force = false) {
    const config = loadTelegramSettings(customConfig);
    if (!config.autoPost && !force) return { success: false, skipped: true };

    const { db, shouldClose, error } = openDatabase(dbOrPath);
    if (error) return { success: false, error };

    ensureTelegramLogTable(db);

    // Auto-settle any pending picks and sync completed scores
    try {
        const { settlePendingAIPicks } = require('./live_companion');
        if (typeof settlePendingAIPicks === 'function') {
            settlePendingAIPicks(db);
        }
        syncSettledLivePredictions(db);
    } catch (_) {}

    const { platformName, provider } = detectProvider(dbOrPath, db);
    if(config.feedStyle==='curated') {
        try {return await require('./telegram_curated_feed').settled(db,{...config,provider});}
        finally {if(shouldClose)db.close();}
    }

    const results = [];

    try {
        // 1. Broadcast confidence filtered results if enabled
        if (config.autoSendConfidenceResults) {
            const confRes = await broadcastConfidenceResults(db, config, force);
            if (confRes.results && confRes.results.length > 0) {
                results.push(...confRes.results);
            }
        }

        // 2. Broadcast standard results only when results are explicitly enabled.
        if (config.autoSendConfidenceResults && config.broadcastMode === 'all') {
            const completedMatches = db.prepare(`
                SELECT * FROM live_predictions 
                WHERE scored_status = 1 
                  AND actual_score IS NOT NULL 
                  AND home_team IS NOT NULL 
                  AND away_team IS NOT NULL
                ORDER BY id DESC LIMIT 100
            `).all();

            const groups = [];
            const seenGroupKeys = new Set();
            for (const m of completedMatches) {
                const gKey = `${m.season_name || 'season'}_w${m.round_number || 0}`;
                if (!seenGroupKeys.has(gKey)) {
                    seenGroupKeys.add(gKey);
                    groups.push({ season_name: m.season_name, round_number: m.round_number });
                }
            }

            for (const group of groups) {
                const roundNum = group.round_number;
                const roundMatches = completedMatches.filter(m => m.season_name === group.season_name && m.round_number === roundNum);
                if (roundMatches.length === 0) continue;

                const firstMatch = roundMatches[0];
                const seasonKey = cleanSeasonKey(firstMatch.season_name, provider);
                const dedupKey = `results_fixtures_${seasonKey}_w${roundNum}`;

                if (!force && isKeySent(db, dedupKey)) continue;

                if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                    markKeySent(db, dedupKey, 'results_fixtures_skipped_frequency');
                    continue;
                }

                const msg = buildFixturesResultsCard(roundNum, firstMatch.season_name, platformName, roundMatches, db, config);
                const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'round_fixtures_results');
                if (sendRes.success && !sendRes.duplicate) {
                    results.push({ round: roundNum, type: 'fixtures_results', messageId: sendRes.messageId });
                }
            }
        } else if (config.autoSendConfidenceResults && ['ai_all', 'ai_only', 'safest', 'high_value'].includes(config.broadcastMode)) {
            const rawSettled = db.prepare(`
                SELECT a.*, 
                       lp.kickoff_timestamp AS lp_kickoff_timestamp, 
                       lp.match_time AS lp_match_time
                FROM ai_best_picks_history a
                LEFT JOIN live_predictions lp 
                  ON lp.home_team = a.home_team 
                 AND lp.away_team = a.away_team 
                 AND lp.season_name = a.season_name 
                 AND lp.round_number = a.round_number
                WHERE a.status IN ('won', 'lost') 
                  AND a.actual_score IS NOT NULL
                  AND a.home_team NOT LIKE 'Skipped%'
                ORDER BY a.id DESC LIMIT 100
            `).all();
            const settledPicks = rawSettled.map(p => ({
                ...p,
                kickoff_timestamp: p.kickoff_timestamp || p.lp_kickoff_timestamp || null,
                match_time: p.match_time || p.lp_match_time || null
            }));

            const groups = [];
            const seenGroupKeys = new Set();
            for (const p of settledPicks) {
                const gKey = `${p.season_name || 'season'}_w${p.round_number || 0}`;
                if (!seenGroupKeys.has(gKey)) {
                    seenGroupKeys.add(gKey);
                    groups.push({ season_name: p.season_name, round_number: p.round_number });
                }
            }

            for (const group of groups) {
                const roundNum = group.round_number;
                let roundPicks = settledPicks.filter(p => p.season_name === group.season_name && p.round_number === roundNum);
                if (config.broadcastMode === 'ai_only') {
                    roundPicks = roundPicks.filter(p => p.pick_type === 'ai_best_pick');
                } else if (config.broadcastMode === 'safest') {
                    roundPicks = roundPicks.filter(p => p.pick_type === 'safest');
                } else if (config.broadcastMode === 'high_value') {
                    roundPicks = roundPicks.filter(p => p.pick_type === 'high_value');
                }

                if (roundPicks.length === 0) continue;

                const seasonName = roundPicks[0]?.season_name;
                const seasonKey = cleanSeasonKey(seasonName, provider);
                const dedupKey = `results_${config.broadcastMode}_${seasonKey}_w${roundNum}`;
                const legacyDedupKey = `results_${seasonKey}_w${roundNum}`;

                if (!force && (isKeySent(db, dedupKey) || isKeySent(db, legacyDedupKey))) continue;

                if (!force && config.broadcastFrequency > 1 && (roundNum % config.broadcastFrequency !== 0)) {
                    markKeySent(db, dedupKey, 'results_ai_skipped_frequency');
                    continue;
                }

                const wonCount = roundPicks.filter(p => p.status === 'won').length;
                const totalCount = roundPicks.length;
                const accuracy = totalCount > 0 ? ((wonCount / totalCount) * 100).toFixed(1) : '0.0';

                const msg = buildRoundResultsCard(roundNum, seasonName, platformName, roundPicks, accuracy, wonCount, totalCount, db, config);
                const sendRes = await broadcastMessage(msg, config, db, dedupKey, 'round_results');
                if (sendRes.success && !sendRes.duplicate) {
                    results.push({ round: roundNum, won: wonCount, total: totalCount, messageId: sendRes.messageId });
                }
            }
        }

        // 3. Check for streak milestones (e.g., 3, 5, 7, 10 wins in a row)
        if (config.autoSendStreakAlerts) {
            const streakInfo = calculateRecentStreak(db);
            if ([3, 5, 7, 10, 15].includes(streakInfo.streak)) {
                const streakDedupKey = `streak_milestone_${streakInfo.streak}_${Math.floor(Date.now() / (10 * 60 * 1000))}`;
                if (!isKeySent(db, streakDedupKey)) {
                    const streakMsg = buildStreakCelebrationCard(streakInfo.streak, streakInfo.recentWins, platformName, config);
                    await broadcastMessage(streakMsg, config, db, streakDedupKey, 'streak_milestone');
                }
            }
        }

    } catch (err) {
        console.error('[Telegram Broadcaster] Error in broadcastSettledResults:', err.message);
        if (shouldClose) db.close();
        return { success: false, error: err.message };
    }

    if (shouldClose) db.close();
    return { success: true, sentCount: results.length, results };
}

/**
 * Send an instant rich test card and verify Bot permissions
 */
async function sendTestIntegrationMessage(customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    if (!config.botToken || !config.chatId) {
        return { ok: false, description: 'Please provide both Telegram Bot Token and Chat ID' };
    }

    const testMsg = `🔔 <b>${escapeHtml(config.channelTitle || 'NEXUS AI')} — Telegram Integration Online!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>Bot Status:</b> Connected & Authorized\n` +
        `📢 <b>Primary Channel:</b> <code>${escapeHtml(config.chatId)}</code>\n` +
        (config.vipGroupId ? `👥 <b>VIP Supergroup:</b> <code>${escapeHtml(config.vipGroupId)}</code>\n` : '') +
        `📤 <b>Broadcast Mode:</b> <code>${escapeHtml(config.broadcastMode)}</code>\n` +
        `🎯 <b>Confidence Filter:</b> <code>≥${config.confidenceFilter}%</code> (Auto-Send: <b>${config.autoSendConfidencePicks ? 'ON' : 'OFF'}</b>)\n` +
        `🕒 <b>Server Time:</b> ${formatWAT()}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🚀 <i>Automated match predictions, settled result scorecards, and streak tracking are fully active!</i>`;

    return sendRawTelegramMessage(config.botToken, config.chatId, testMsg);
}

/**
 * Handle Auto-Kick for Expired VIP Members from VIP Supergroup
 */
async function kickExpiredVipSubscriber(sub, customConfig = {}) {
    const config = loadTelegramSettings(customConfig);
    const targetGroup = config.vipGroupId || config.chatId;

    if (!config.botToken || !targetGroup || !sub?.chatId) {
        return { ok: false, description: 'Missing credentials or subscriber chatId' };
    }

    try {
        console.log(`[Telegram VIP] Auto-kicking expired member: ${sub.name || sub.chatId} from ${targetGroup}...`);
        const banUrl = `https://api.telegram.org/bot${config.botToken}/banChatMember`;
        const banRes = await fetch(banUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: targetGroup, user_id: sub.chatId })
        });
        const banData = await banRes.json();

        if (banData.ok) {
            const unbanUrl = `https://api.telegram.org/bot${config.botToken}/unbanChatMember`;
            await fetch(unbanUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: targetGroup, user_id: sub.chatId })
            });
            return { ok: true };
        } else {
            return { ok: false, description: banData.description };
        }
    } catch (err) {
        return { ok: false, description: err.message };
    }
}

module.exports = {
    DEFAULT_BOT_TOKEN,
    DEFAULT_CHAT_ID,
    DEFAULT_CHANNEL_TITLE,
    DEFAULT_TAGLINE,
    DEFAULT_FOOTER,
    loadTelegramSettings,
    saveTelegramSettings,
    sendRawTelegramMessage,
    sendTestIntegrationMessage,
    broadcastMessage,
    broadcastPendingPredictions,
    broadcastSettledResults,
    broadcastConfidencePredictions,
    broadcastConfidenceResults,
    calculateConfidenceForPrediction,
    calculateConfidenceHistory,
    calculateRecentStreak,
    kickExpiredVipSubscriber,
    clearTelegramDedupLog,
    getRecentTelegramLogs,
    formatWAT,
    renderConfidenceBar,
    getOppositeMarketTip,
    extractMatchMeta,
    calculateHistoricalStats,
    buildRoundResultsCard,
    buildBundledAiCard,
    buildSingleAiPickCard,
    buildUpcomingFixturesCard,
    buildConfidenceFilteredCard,
    buildConfidenceFilteredResultsCard,
    buildFixturesResultsCard,
    buildStreakCelebrationCard,
    buildDailyPerformanceReport
};
