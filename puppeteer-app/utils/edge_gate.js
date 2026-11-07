'use strict';

/**
 * utils/edge_gate.js — Evidence gate for pick publication.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A backtest of ~57k settled SportyBet VFL matches (real captured odds + real results) showed:
 *   • every market loses money when bet blindly (average margin ≈ -8.7%, 1X2/OU ≈ -5.3%, HT/FT up to -23%);
 *   • the bookmaker's de-vigged probabilities are almost perfectly calibrated;
 *   • the in-house model's probabilities have a WORSE Brier score than the bookmaker in every market, and the
 *     slope of outcome-vs-(model - book) disagreement is ≈ 0 → the model's "EV" is noise, so selecting the largest
 *     model-vs-book gaps just selects model errors (winner's curse).
 * Forced picks (the pipelines' fallbacks always emit a bet) therefore pay the bookmaker margin every round.
 *
 * WHAT IT DOES
 * ────────────
 * A pick is published only if, over the most recent settled matches, betting that market whenever
 * (modelProb - de-vigged bookProb) >= minGap has been:
 *   1. based on at least `edgeGateMinSample` bets,
 *   2. profitable with a one-sided ~90% lower confidence bound on ROI > 0,
 *   3. profitable in BOTH the older and the newer half of the window (time-stable).
 * Evidence is recomputed from live_predictions (which keeps growing even when no picks are made), so the gate
 * re-opens automatically, per market, if a real edge ever appears. No shadow bets are needed.
 *
 * SETTINGS (bot_settings.json, all optional)
 *   strictEdgeGate     boolean  default true   — set false to restore the legacy always-pick behaviour
 *   edgeGateMinGap     number   default 0.05   — min (model - de-vigged book) probability gap
 *   edgeGateMinSample  number   default 300
 *   edgeGateWindow     number   default 15000  — most recent settled matches used as evidence
 *   edgeGateZ          number   default 1.2816 — one-sided confidence z (1.2816 ≈ 90%)
 *   edgeGateCacheMs    number   default 900000 — evidence cache lifetime
 *
 * CLI report:  node utils/edge_gate_report.js [path/to/sportybet_archive.db]
 */

let _getBotSettings = () => ({});
try { _getBotSettings = require('./path_resolver').getBotSettings; } catch (e) { /* standalone use */ }

const DEFAULTS = {
    strictEdgeGate: true,
    edgeGateMinGap: 0.05,
    edgeGateMinSample: 300,
    edgeGateWindow: 15000,
    edgeGateZ: 1.2816,
    edgeGateCacheMs: 15 * 60 * 1000
};

function getSettings() {
    let s = {};
    try { s = _getBotSettings() || {}; } catch (e) { s = {}; }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (s[k] !== undefined && s[k] !== null && typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
    }
    return out;
}

function isEnabled() {
    return getSettings().strictEdgeGate !== false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Market definitions
// ─────────────────────────────────────────────────────────────────────────────

const pctOr = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** group -> list of { label, odds: fn(oddsObj), prob: fn(probsObj) -> percent, win: fn(h, a, hth, hta) } */
const GROUPS = {
    '1x2': [
        { label: 'Home Win', odds: o => o.home, prob: p => pctOr(p.homeWinProb), win: (h, a) => h > a },
        { label: 'Draw', odds: o => o.draw,
          prob: p => pctOr(p.drawProb) ?? (pctOr(p.homeWinProb) !== null && pctOr(p.awayWinProb) !== null ? 100 - p.homeWinProb - p.awayWinProb : null),
          win: (h, a) => h === a },
        { label: 'Away Win', odds: o => o.away, prob: p => pctOr(p.awayWinProb), win: (h, a) => h < a }
    ],
    'gg': [
        { label: 'Both Teams to Score (GG)', odds: o => o.gg, prob: p => pctOr(p.ggProb), win: (h, a) => h > 0 && a > 0 },
        { label: 'Both Teams NOT to Score (No GG)', odds: o => o.ng,
          prob: p => (pctOr(p.noGgProb) ?? (pctOr(p.ggProb) !== null ? 100 - p.ggProb : null)), win: (h, a) => h === 0 || a === 0 }
    ]
};
for (const [line, k] of [[1.5, '15'], [2.5, '25'], [3.5, '35']]) {
    GROUPS['ou' + k] = [
        { label: `Over ${line} Goals`, odds: o => o['over' + k], prob: p => pctOr(p['over' + k + 'Prob']), win: (h, a) => h + a > line },
        { label: `Under ${line} Goals`, odds: o => o['under' + k],
          prob: p => (pctOr(p['under' + k + 'Prob']) ?? (pctOr(p['over' + k + 'Prob']) !== null ? 100 - p['over' + k + 'Prob'] : null)),
          win: (h, a) => h + a < line }
    ];
}
GROUPS.htft = ['11', '1X', '12', 'X1', 'XX', 'X2', '21', '2X', '22'].map(c => ({
    label: `HT/FT ${c[0]}/${c[1]}`,
    odds: o => (o.htft || o.halftimeFulltime || {})['htft' + c],
    prob: p => pctOr(p['htft' + c + 'Prob']),
    win: (h, a, hth, hta) => {
        if (hth === null || hta === null) return null;
        const ht = hth > hta ? '1' : hth < hta ? '2' : 'X';
        const ft = h > a ? '1' : h < a ? '2' : 'X';
        return ht === c[0] && ft === c[1];
    }
}));

const MARKET_INDEX = {};   // normalized label (lowercase) -> { group, def }
for (const [group, defs] of Object.entries(GROUPS)) {
    for (const d of defs) MARKET_INDEX[d.label.toLowerCase()] = { group, def: d };
}
const ALIASES = {
    'home': 'home win', 'away': 'away win',
    'both teams to score': 'both teams to score (gg)', 'gg': 'both teams to score (gg)',
    'both teams not to score': 'both teams not to score (no gg)', 'ng': 'both teams not to score (no gg)',
    'no gg': 'both teams not to score (no gg)'
};

/** Map any label used by the app to a canonical market entry, or null if unsupported. */
function resolveMarket(label) {
    if (!label) return null;
    let key = String(label).trim().toLowerCase();
    if (ALIASES[key]) key = ALIASES[key];
    if (MARKET_INDEX[key]) return MARKET_INDEX[key];
    if (key.startsWith('ht/ft ')) {   // e.g. "ht/ft x/2"
        const t = key.slice(6).replace(/\s+/g, '');
        const hit = Object.keys(MARKET_INDEX).find(k => k === 'ht/ft ' + t);
        if (hit) return MARKET_INDEX[hit];
    }
    return null;
}

/** De-vig a group: returns { label: fairProb(0..1) } or null when any quote is missing. */
function devigGroup(group, odds) {
    const defs = GROUPS[group];
    const inv = [];
    for (const d of defs) {
        const q = parseFloat(d.odds(odds));
        if (!(q > 1)) return null;
        inv.push(1 / q);
    }
    const sum = inv.reduce((a, b) => a + b, 0);
    const out = {};
    defs.forEach((d, i) => { out[d.label] = inv[i] / sum; });
    return out;
}

function parseScore(s) {
    if (!s || typeof s !== 'string') return [null, null];
    const m = s.replace('-', ':').split(':');
    const h = parseInt(m[0], 10), a = parseInt(m[1], 10);
    return (isNaN(h) || isNaN(a)) ? [null, null] : [h, a];
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure function (no DB): rows must be ordered oldest -> newest.
 * @param {Array<{probs:object, odds:object, score:string, htScore?:string}>} rows
 * @param {object} cfg settings
 * @returns {Object<string, MarketEvidence>}
 */
function computeEvidence(rows, cfg = getSettings()) {
    const half = Math.floor(rows.length / 2);
    const acc = {};
    for (const defs of Object.values(GROUPS)) {
        for (const d of defs) acc[d.label] = { n: 0, s: 0, s2: 0, nOld: 0, sOld: 0, nNew: 0, sNew: 0 };
    }
    rows.forEach((r, idx) => {
        const [h, a] = parseScore(r.score);
        if (h === null) return;
        const [hth, hta] = parseScore(r.htScore);
        for (const [group, defs] of Object.entries(GROUPS)) {
            const fair = devigGroup(group, r.odds);
            if (!fair) continue;
            for (const d of defs) {
                const mp = d.prob(r.probs);
                if (mp === null) continue;
                if (mp / 100 - fair[d.label] < cfg.edgeGateMinGap) continue;
                const won = d.win(h, a, hth, hta);
                if (won === null) continue;
                const odd = parseFloat(d.odds(r.odds));
                const ret = won ? odd - 1 : -1;
                const A = acc[d.label];
                A.n++; A.s += ret; A.s2 += ret * ret;
                if (idx < half) { A.nOld++; A.sOld += ret; } else { A.nNew++; A.sNew += ret; }
            }
        }
    });

    const out = {};
    for (const [label, A] of Object.entries(acc)) {
        const roi = A.n ? A.s / A.n : 0;
        const variance = A.n > 1 ? Math.max(0, (A.s2 - A.n * roi * roi) / (A.n - 1)) : 0;
        const se = A.n > 1 ? Math.sqrt(variance / A.n) : Infinity;
        const lcb = A.n > 1 ? roi - cfg.edgeGateZ * se : -Infinity;
        const roiOld = A.nOld ? A.sOld / A.nOld : null;
        const roiNew = A.nNew ? A.sNew / A.nNew : null;
        let reason = null;
        if (A.n < cfg.edgeGateMinSample) reason = `only ${A.n} qualifying bets (need ${cfg.edgeGateMinSample})`;
        else if (!(lcb > 0)) reason = `ROI ${(roi * 100).toFixed(1)}% with lower bound ${(lcb * 100).toFixed(1)}% (needs > 0)`;
        else if (!(A.nOld >= 30 && A.nNew >= 30 && roiOld > 0 && roiNew > 0)) reason = 'not profitable in both halves of the window (unstable)';
        out[label] = {
            market: label, n: A.n, roiPct: +(roi * 100).toFixed(2), lcbPct: isFinite(lcb) ? +(lcb * 100).toFixed(2) : null,
            nOld: A.nOld, roiOldPct: roiOld === null ? null : +(roiOld * 100).toFixed(2),
            nNew: A.nNew, roiNewPct: roiNew === null ? null : +(roiNew * 100).toFixed(2),
            validated: reason === null, reason: reason || 'validated'
        };
    }
    return out;
}

const _cache = new Map();   // db key -> { at, evidence }

/** Load recent settled matches from live_predictions and compute (cached) evidence. */
function getEvidence(db, opts = {}) {
    const cfg = getSettings();
    const key = (db && db.name) || 'default';
    const hit = _cache.get(key);
    if (!opts.force && hit && Date.now() - hit.at < cfg.edgeGateCacheMs) return hit.evidence;

    let rows = [];
    try {
        const raw = db.prepare(`
            SELECT predicted_probs, bookmaker_odds, actual_score, actual_ht_score
            FROM live_predictions
            WHERE actual_score IS NOT NULL AND predicted_probs IS NOT NULL AND bookmaker_odds IS NOT NULL
            ORDER BY kickoff_timestamp DESC LIMIT ?
        `).all(cfg.edgeGateWindow);
        for (let i = raw.length - 1; i >= 0; i--) {   // oldest -> newest
            try {
                rows.push({
                    probs: JSON.parse(raw[i].predicted_probs), odds: JSON.parse(raw[i].bookmaker_odds),
                    score: raw[i].actual_score, htScore: raw[i].actual_ht_score
                });
            } catch (e) { /* skip malformed row */ }
        }
    } catch (e) {
        console.warn('[EdgeGate] could not load evidence rows:', e.message);
    }
    const evidence = computeEvidence(rows, cfg);
    evidence._meta = { rows: rows.length, computedAt: Date.now(), settings: cfg };
    _cache.set(key, { at: Date.now(), evidence });
    return evidence;
}

function anyMarketValidated(evidence) {
    return Object.entries(evidence || {}).some(([k, v]) => k !== '_meta' && v.validated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick-level gate
// ─────────────────────────────────────────────────────────────────────────────

const _logged = new Map();
function logThrottled(key, msg, everyMs = 15 * 60 * 1000) {
    const last = _logged.get(key) || 0;
    if (Date.now() - last > everyMs) { _logged.set(key, Date.now()); console.log(msg); }
}

/**
 * Decide whether a generated pick may be published.
 * Fails CLOSED: anything that cannot be verified is blocked.
 *
 * @param {object} db   better-sqlite3 handle
 * @param {string} pickType 'safest' | 'high_value' | 'ai_best_pick'
 * @param {object} pick  { market, match: { predicted_probs, bookmaker_odds } }
 * @returns {{allowed: boolean, reason: string, evidence?: object}}
 */
function check(db, pickType, pick) {
    const cfg = getSettings();
    if (cfg.strictEdgeGate === false) return { allowed: true, reason: 'gate disabled' };
    if (!pick || !pick.market) return { allowed: false, reason: 'no pick' };

    const entry = resolveMarket(pick.market);
    if (!entry) return { allowed: false, reason: `market "${pick.market}" is not covered by the edge gate` };

    const ev = getEvidence(db)[entry.def.label];
    if (!ev || !ev.validated) {
        return { allowed: false, reason: `no validated edge for ${entry.def.label}: ${ev ? ev.reason : 'no data'}`, evidence: ev };
    }

    // The specific pick must itself show the validated gap vs the de-vigged price.
    try {
        const m = pick.match || {};
        const probs = typeof m.predicted_probs === 'string' ? JSON.parse(m.predicted_probs) : (m.predicted_probs || {});
        const odds = typeof m.bookmaker_odds === 'string' ? JSON.parse(m.bookmaker_odds) : (m.bookmaker_odds || {});
        const fair = devigGroup(entry.group, odds);
        const mp = entry.def.prob(probs);
        if (!fair || mp === null) return { allowed: false, reason: 'cannot de-vig this pick (missing odds or probabilities)', evidence: ev };
        const gap = mp / 100 - fair[entry.def.label];
        if (gap < cfg.edgeGateMinGap) {
            return { allowed: false, reason: `pick gap ${(gap * 100).toFixed(1)}pp < required ${(cfg.edgeGateMinGap * 100).toFixed(1)}pp`, evidence: ev };
        }
    } catch (e) {
        return { allowed: false, reason: 'gap check failed: ' + e.message, evidence: ev };
    }
    return { allowed: true, reason: 'validated edge', evidence: ev };
}

module.exports = {
    DEFAULTS,
    getSettings,
    isEnabled,
    resolveMarket,
    devigGroup,
    computeEvidence,
    getEvidence,
    anyMarketValidated,
    check,
    logThrottled
};
