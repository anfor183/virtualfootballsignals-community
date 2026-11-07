'use strict';

/**
 * utils/paper_trader_htdraw.js
 *
 * PAPER-TRADING tracker for the "6-hour cycle Half-Time Draw" strategy on SportyBet virtual England.
 * No real money is involved: it logs a hypothetical 1-unit bet for every qualifying match and settles it
 * once the score is in, so we can find out whether the edge found in the backtest survives on NEW data.
 *
 * Background (backtest 20 Sep - 2 Oct 2026, 56,985 matches):
 *   - The half-time draw rate follows a 6-hour cycle in UTC time. It is lowest in the first hour of each
 *     cycle (00,06,12,18 UTC) and highest in the last three (03-06, 09-12, 15-18, 21-24 UTC).
 *   - SportyBet prices the HT Draw at the same implied probability (~45.65%) at every hour.
 *   - HT Draw in the "on" hours: +2.35% ROI, 28,300 bets, 10/13 positive days. NOT yet proven.
 *
 * Strategies tracked (all flat 1-unit stakes):
 *   FROZEN_HTD   : HT Draw when (UTC hour % 6) in {3,4,5}. Rule fixed on 2026-10-05, never re-fitted.
 *   ADAPTIVE_HTD : HT Draw in the 3 cycle positions with the highest HT-draw rate using only data before that day.
 *   FROZEN_X1X2  : HT/FT X/1 and X/2 (1 unit each) in the same hours as FROZEN_HTD.
 *   CONTROL_HTD  : HT Draw on EVERY match (baseline - should lose roughly the bookmaker margin).
 *
 * Only bets with kickoff >= GO_LIVE count as the forward test. Earlier matches are labelled "backtest".
 *
 * Usage:
 *   node utils/paper_trader_htdraw.js            # sync once, print report, write HTML report
 *   node utils/paper_trader_htdraw.js --watch    # keep syncing every 2 minutes (shows upcoming bets)
 *   node utils/paper_trader_htdraw.js --db path/to/sportybet_archive.db
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDatabasePath } = require('./path_resolver');

// ---------------------------------------------------------------- configuration (pre-registered)
const GO_LIVE_ISO = '2026-10-05T00:00:00Z';
const GO_LIVE = Date.parse(GO_LIVE_ISO);
const FROZEN_POSITIONS = [3, 4, 5];          // UTC hour % 6
const ADAPTIVE_TOP_K = 3;
const ADAPTIVE_MIN_DAYS = 3;                 // need this many prior days before the adaptive rule bets
const RAW_IDX = { htHome: 124, htDraw: 125, htAway: 126 };   // positions in bookmaker_odds.raw
const RAW_LEN = 450;
const VERDICT_MIN_BETS = 15000;              // forward bets needed before a verdict on FROZEN_HTD
const WATCH_INTERVAL_MS = 2 * 60 * 1000;

const STRATEGIES = {
    FROZEN_HTD: 'HT Draw in hours 03-06/09-12/15-18/21-24 UTC (frozen rule)',
    ADAPTIVE_HTD: 'HT Draw in best 3 cycle positions from previous days',
    FROZEN_X1X2: 'HT/FT X/1 + X/2 in frozen hours',
    CONTROL_HTD: 'HT Draw on every match (control / baseline)'
};

// ---------------------------------------------------------------- args & paths
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const WATCH = args.includes('--watch');
const srcPath = resolveDatabasePath(argVal('--db'), 'sportybet_archive.db');
const paperPath = path.join(path.dirname(srcPath), 'paper_trading.db');
const reportDir = path.join(__dirname, '..', 'reports');
const reportPath = path.join(reportDir, 'htdraw_paper_report.html');

// ---------------------------------------------------------------- helpers
const cyclePos = (ts) => new Date(ts).getUTCHours() % 6;
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const parseScore = (s) => {
    if (!s || typeof s !== 'string' || !s.includes(':')) return null;
    const [a, b] = s.split(':').map((x) => parseInt(x, 10));
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
};
const fmtPct = (x, d = 2) => (x === null || !Number.isFinite(x) ? '-' : (x * 100).toFixed(d) + '%');
const fmtNum = (x, d = 1) => (x === null || !Number.isFinite(x) ? '-' : x.toFixed(d));
const localTime = (ts) => new Date(ts).toLocaleString('en-GB', { hour12: false });

function parseOdds(json) {
    try {
        const o = JSON.parse(json);
        const raw = Array.isArray(o.raw) ? o.raw : null;
        if (!raw || raw.length !== RAW_LEN) return null;
        const htDraw = parseFloat(raw[RAW_IDX.htDraw]);
        const x1 = parseFloat(o.htft && o.htft.htftX1);
        const x2 = parseFloat(o.htft && o.htft.htftX2);
        if (!(htDraw > 1)) return null;
        // sanity check: HT home/draw/away triplet should have an overround between 1.0 and 1.25
        const ov = 1 / parseFloat(raw[RAW_IDX.htHome]) + 1 / htDraw + 1 / parseFloat(raw[RAW_IDX.htAway]);
        if (!(ov > 1.0 && ov < 1.25)) return null;
        return { htDraw, x1: x1 > 1 ? x1 : null, x2: x2 > 1 ? x2 : null };
    } catch (_) { return null; }
}

// ---------------------------------------------------------------- database setup
function openDbs() {
    const src = new Database(srcPath, { readonly: true, fileMustExist: true });
    src.pragma('busy_timeout = 10000');
    const db = new Database(paperPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS paper_bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy TEXT NOT NULL,
            market TEXT NOT NULL,
            season_name TEXT, round_number INTEGER,
            home_team TEXT, away_team TEXT,
            kickoff_ts INTEGER NOT NULL,
            cycle_pos INTEGER,
            odds REAL NOT NULL,
            stake REAL NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'pending',
            pnl REAL,
            ht_score TEXT, ft_score TEXT,
            phase TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            settled_at TEXT,
            UNIQUE(strategy, market, season_name, home_team, away_team)
        );
        CREATE INDEX IF NOT EXISTS idx_pb_strat ON paper_bets(strategy, phase, status);
        CREATE INDEX IF NOT EXISTS idx_pb_kick ON paper_bets(kickoff_ts);
        CREATE TABLE IF NOT EXISTS paper_meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    db.prepare(`INSERT OR IGNORE INTO paper_meta(k, v) VALUES ('go_live', ?)`).run(GO_LIVE_ISO);
    db.prepare(`INSERT OR IGNORE INTO paper_meta(k, v) VALUES ('frozen_positions', ?)`).run(JSON.stringify(FROZEN_POSITIONS));
    return { src, db };
}

// ---------------------------------------------------------------- adaptive rule: best cycle positions per day
function buildAdaptivePicks(src) {
    // HT-draw rate per (day, cycle position) from settled matches
    const rows = src.prepare(`
        SELECT kickoff_timestamp ts, actual_ht_score ht FROM live_predictions
        WHERE kickoff_timestamp IS NOT NULL AND actual_ht_score LIKE '%:%'`).all();
    const agg = new Map(); // day -> [ {n, d} x6 ]
    for (const r of rows) {
        const s = parseScore(r.ht); if (!s) continue;
        const day = utcDay(r.ts);
        if (!agg.has(day)) agg.set(day, Array.from({ length: 6 }, () => ({ n: 0, d: 0 })));
        const cell = agg.get(day)[cyclePos(r.ts)];
        cell.n++; if (s[0] === s[1]) cell.d++;
    }
    const days = [...agg.keys()].sort();
    const picks = new Map(); // day -> Set(positions) using only days strictly before
    const cum = Array.from({ length: 6 }, () => ({ n: 0, d: 0 }));
    const allDays = new Set(days);
    // include "today" and "tomorrow" so upcoming matches get a pick as well
    const extra = [utcDay(Date.now()), utcDay(Date.now() + 86400000)];
    extra.forEach((d) => allDays.add(d));
    const sortedAll = [...allDays].sort();
    let seen = 0;
    for (const day of sortedAll) {
        if (seen >= ADAPTIVE_MIN_DAYS) {
            const ranked = cum.map((c, i) => ({ i, rate: c.n ? c.d / c.n : 0 })).sort((a, b) => b.rate - a.rate);
            picks.set(day, new Set(ranked.slice(0, ADAPTIVE_TOP_K).map((x) => x.i)));
        }
        if (agg.has(day)) {
            agg.get(day).forEach((c, i) => { cum[i].n += c.n; cum[i].d += c.d; });
            seen++;
        }
    }
    return picks;
}

// ---------------------------------------------------------------- sync: create + settle paper bets
function sync(src, db) {
    const adaptive = buildAdaptivePicks(src);
    const matchStmt = src.prepare(`
        SELECT season_name, round_number, home_team, away_team, kickoff_timestamp ts,
               actual_score ft, actual_ht_score ht, bookmaker_odds odds
        FROM live_predictions
        WHERE kickoff_timestamp IS NOT NULL AND bookmaker_odds IS NOT NULL`);

    const insert = db.prepare(`
        INSERT OR IGNORE INTO paper_bets
          (strategy, market, season_name, round_number, home_team, away_team, kickoff_ts, cycle_pos, odds, stake, phase)
        VALUES (@strategy, @market, @season_name, @round_number, @home_team, @away_team, @ts, @pos, @odds, @stake, @phase)`);
    const settle = db.prepare(`
        UPDATE paper_bets SET status=@status, pnl=@pnl, ht_score=@ht, ft_score=@ft, settled_at=CURRENT_TIMESTAMP
        WHERE strategy=@strategy AND market=@market AND season_name=@season_name AND home_team=@home_team
          AND away_team=@away_team AND status='pending'`);

    let created = 0, settled = 0;
    const tx = db.transaction(() => {
        for (const m of matchStmt.iterate()) {
            const o = parseOdds(m.odds); if (!o) continue;
            const pos = cyclePos(m.ts);
            const phase = m.ts >= GO_LIVE ? 'forward' : 'backtest';
            const base = { season_name: m.season_name, round_number: m.round_number, home_team: m.home_team,
                           away_team: m.away_team, ts: m.ts, pos, phase, stake: 1 };
            const bets = [{ strategy: 'CONTROL_HTD', market: 'HT_DRAW', odds: o.htDraw }];
            if (FROZEN_POSITIONS.includes(pos)) {
                bets.push({ strategy: 'FROZEN_HTD', market: 'HT_DRAW', odds: o.htDraw });
                if (o.x1) bets.push({ strategy: 'FROZEN_X1X2', market: 'HTFT_X1', odds: o.x1 });
                if (o.x2) bets.push({ strategy: 'FROZEN_X1X2', market: 'HTFT_X2', odds: o.x2 });
            }
            const ap = adaptive.get(utcDay(m.ts));
            if (ap && ap.has(pos)) bets.push({ strategy: 'ADAPTIVE_HTD', market: 'HT_DRAW', odds: o.htDraw });

            const ht = parseScore(m.ht), ft = parseScore(m.ft);
            for (const b of bets) {
                created += insert.run({ ...base, ...b }).changes;
                if (ht && ft) {
                    const htRes = ht[0] > ht[1] ? '1' : ht[0] < ht[1] ? '2' : 'X';
                    const ftRes = ft[0] > ft[1] ? '1' : ft[0] < ft[1] ? '2' : 'X';
                    let won;
                    if (b.market === 'HT_DRAW') won = htRes === 'X';
                    else if (b.market === 'HTFT_X1') won = htRes === 'X' && ftRes === '1';
                    else won = htRes === 'X' && ftRes === '2';
                    settled += settle.run({ ...base, ...b, status: won ? 'won' : 'lost',
                        pnl: won ? b.odds - 1 : -1, ht: m.ht, ft: m.ft }).changes;
                }
            }
        }
    });
    tx();
    return { created, settled, latestMatch: src.prepare('SELECT max(kickoff_timestamp) m FROM live_predictions').get().m };
}

// ---------------------------------------------------------------- statistics
function stats(db, strategy, phase) {
    const rows = db.prepare(`
        SELECT kickoff_ts ts, odds, stake, pnl, status FROM paper_bets
        WHERE strategy=? AND phase=? AND status IN ('won','lost') ORDER BY kickoff_ts`).all(strategy, phase);
    const n = rows.length;
    if (!n) return { n: 0 };
    let staked = 0, pnl = 0, wins = 0, peak = 0, maxDD = 0, sumSq = 0, impl = 0;
    const daily = new Map(); const curve = [];
    for (const r of rows) {
        staked += r.stake; pnl += r.pnl; sumSq += r.pnl * r.pnl; impl += 1 / r.odds;
        if (r.status === 'won') wins++;
        peak = Math.max(peak, pnl); maxDD = Math.max(maxDD, peak - pnl);
        const d = utcDay(r.ts);
        if (!daily.has(d)) daily.set(d, { n: 0, pnl: 0, staked: 0, wins: 0 });
        const c = daily.get(d); c.n++; c.pnl += r.pnl; c.staked += r.stake; if (r.status === 'won') c.wins++;
        curve.push([r.ts, pnl]);
    }
    const mean = pnl / n;
    const sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-12));
    const se = sd / Math.sqrt(n);
    const roi = pnl / staked;
    const days = [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return {
        n, staked, pnl, roi, wins, hitRate: wins / n, impliedRate: impl / n, maxDD,
        z: mean / se, ciLow: (mean - 1.96 * se) / (staked / n), ciHigh: (mean + 1.96 * se) / (staked / n),
        posDays: days.filter(([, c]) => c.pnl > 0).length, totalDays: days.length,
        worstDay: Math.min(...days.map(([, c]) => c.pnl)), bestDay: Math.max(...days.map(([, c]) => c.pnl)),
        days, curve
    };
}

function verdict(s) {
    if (!s.n) return { label: 'WAITING FOR DATA', color: '#888', text: 'No settled forward bets yet. Make sure the scraper is running.' };
    if (s.n >= VERDICT_MIN_BETS && s.ciLow > 0) return { label: 'EDGE CONFIRMED', color: '#1a7f37',
        text: `95% confidence interval is entirely above 0 after ${s.n} bets. Consider small real stakes (see guide).` };
    if (s.n >= VERDICT_MIN_BETS && s.roi <= 0) return { label: 'EDGE FAILED', color: '#cf222e',
        text: `ROI is not positive after ${s.n} forward bets. The backtest pattern was noise - do not bet.` };
    if (s.ciHigh < 0) return { label: 'EDGE FAILED', color: '#cf222e', text: 'Even the optimistic end of the 95% interval is negative. Stop.' };
    const pct = Math.min(100, (100 * s.n) / VERDICT_MIN_BETS).toFixed(0);
    return { label: 'KEEP COLLECTING', color: '#bf8700',
        text: `${s.n} / ${VERDICT_MIN_BETS} forward bets (${pct}%). Too early to judge - do NOT stake real money yet.` };
}

// ---------------------------------------------------------------- upcoming bets (for live paper/manual tracking)
function upcoming(db, limit = 20) {
    return db.prepare(`
        SELECT kickoff_ts, home_team, away_team, odds FROM paper_bets
        WHERE strategy='FROZEN_HTD' AND status='pending' AND kickoff_ts >= ? ORDER BY kickoff_ts LIMIT ?`)
        .all(Date.now() - 60 * 1000, limit);
}

function nextWindow(now = Date.now()) {
    const d = new Date(now); const pos = d.getUTCHours() % 6;
    if (FROZEN_POSITIONS.includes(pos)) {
        const end = new Date(d); end.setUTCHours(d.getUTCHours() + (6 - pos), 0, 0, 0);
        return { active: true, until: end.getTime() };
    }
    const start = new Date(d); start.setUTCHours(d.getUTCHours() + (FROZEN_POSITIONS[0] - pos), 0, 0, 0);
    return { active: false, from: start.getTime() };
}

// ---------------------------------------------------------------- console report
function printReport(db, info) {
    const line = '-'.repeat(118);
    console.log('\n' + '='.repeat(118));
    console.log(` HT DRAW 6-HOUR CYCLE - PAPER TRADING REPORT   (${localTime(Date.now())})`);
    console.log('='.repeat(118));
    console.log(` Source DB     : ${srcPath}`);
    console.log(` Paper DB      : ${paperPath}`);
    console.log(` Forward start : ${GO_LIVE_ISO}   |  newest match in DB: ${info.latestMatch ? new Date(info.latestMatch).toISOString() : '-'}`);
    const stale = info.latestMatch && Date.now() - info.latestMatch > 30 * 60 * 1000;
    if (stale) console.log(` !! WARNING: newest match is ${((Date.now() - info.latestMatch) / 3600000).toFixed(1)} h old - the scraper does not seem to be running.`);
    console.log(` This sync     : +${info.created} new paper bets, ${info.settled} settled`);
    const w = nextWindow();
    console.log(` Bet window    : ${w.active ? 'ACTIVE until ' + localTime(w.until) : 'closed - next opens ' + localTime(w.from)} (your local time)`);
    for (const phase of ['forward', 'backtest']) {
        console.log('\n ' + (phase === 'forward' ? 'FORWARD TEST (new, unseen data - this is what matters)' : 'BACKTEST (data used to discover the pattern - optimistic)'));
        console.log(line);
        console.log(' ' + 'Strategy'.padEnd(14) + 'Bets'.padStart(8) + 'Hit%'.padStart(8) + 'Need%'.padStart(8) + 'P&L(u)'.padStart(10) +
            'ROI'.padStart(9) + '95% CI'.padStart(20) + 'z'.padStart(7) + '+Days'.padStart(9) + 'WorstDay'.padStart(10) + 'MaxDD'.padStart(9));
        console.log(line);
        for (const k of Object.keys(STRATEGIES)) {
            const s = stats(db, k, phase);
            if (!s.n) { console.log(' ' + k.padEnd(14) + '       0   (no settled bets yet)'); continue; }
            console.log(' ' + k.padEnd(14) + String(s.n).padStart(8) + fmtPct(s.hitRate, 1).padStart(8) + fmtPct(s.impliedRate, 1).padStart(8) +
                fmtNum(s.pnl).padStart(10) + fmtPct(s.roi).padStart(9) + `[${fmtPct(s.ciLow, 1)}, ${fmtPct(s.ciHigh, 1)}]`.padStart(20) +
                fmtNum(s.z, 2).padStart(7) + `${s.posDays}/${s.totalDays}`.padStart(9) + fmtNum(s.worstDay).padStart(10) + fmtNum(s.maxDD).padStart(9));
        }
    }
    const v = verdict(stats(db, 'FROZEN_HTD', 'forward'));
    console.log('\n VERDICT (FROZEN_HTD, forward): ' + v.label + ' - ' + v.text);
    const up = upcoming(db, 10);
    if (up.length) {
        console.log('\n Next qualifying matches (FROZEN_HTD - paper bet "Half-Time Draw"):');
        up.forEach((u) => console.log(`   ${localTime(u.kickoff_ts)}  ${u.home_team} v ${u.away_team}  @ ${u.odds.toFixed(2)}`));
    }
    console.log(`\n HTML report: ${reportPath}\n`);
}

// ---------------------------------------------------------------- HTML report
function svgCurve(curves, w = 900, h = 260) {
    const all = curves.flatMap((c) => c.points);
    if (!all.length) return '<p>No data yet.</p>';
    let x0 = Infinity, x1 = -Infinity, y0 = 0, y1 = 0;
    for (const [x, y] of all) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const sx = (x) => 40 + ((x - x0) / Math.max(x1 - x0, 1)) * (w - 60);
    const sy = (y) => 10 + (1 - (y - y0) / Math.max(y1 - y0, 1)) * (h - 40);
    const paths = curves.map((c) => {
        const step = Math.max(1, Math.floor(c.points.length / 600));
        const pts = c.points.filter((_, i) => i % step === 0 || i === c.points.length - 1);
        return `<polyline fill="none" stroke="${c.color}" stroke-width="1.6" points="${pts.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')}"/>`;
    }).join('');
    const legend = curves.map((c, i) => `<text x="${50 + i * 170}" y="${h - 6}" fill="${c.color}" font-size="12">&#9632; ${c.name}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="background:#fafafa;border:1px solid #ddd;border-radius:6px">
      <line x1="40" x2="${w - 20}" y1="${sy(0)}" y2="${sy(0)}" stroke="#999" stroke-dasharray="4"/>
      <text x="4" y="${sy(y1) + 4}" font-size="11">${y1.toFixed(0)}u</text><text x="4" y="${sy(y0)}" font-size="11">${y0.toFixed(0)}u</text>
      ${paths}${legend}</svg>`;
}

function writeHtml(db, info) {
    const colors = { FROZEN_HTD: '#1f6feb', ADAPTIVE_HTD: '#8250df', FROZEN_X1X2: '#bf8700', CONTROL_HTD: '#cf222e' };
    const section = (phase) => {
        const st = Object.keys(STRATEGIES).map((k) => [k, stats(db, k, phase)]);
        const rows = st.map(([k, s]) => s.n ? `<tr><td><b style="color:${colors[k]}">${k}</b><br><small>${STRATEGIES[k]}</small></td>
            <td>${s.n}</td><td>${fmtPct(s.hitRate, 1)}</td><td>${fmtPct(s.impliedRate, 1)}</td>
            <td style="color:${s.pnl >= 0 ? '#1a7f37' : '#cf222e'}"><b>${fmtNum(s.pnl)}</b></td>
            <td><b>${fmtPct(s.roi)}</b></td><td>[${fmtPct(s.ciLow, 1)}, ${fmtPct(s.ciHigh, 1)}]</td><td>${fmtNum(s.z, 2)}</td>
            <td>${s.posDays}/${s.totalDays}</td><td>${fmtNum(s.worstDay)}</td><td>${fmtNum(s.maxDD)}</td></tr>`
            : `<tr><td><b style="color:${colors[k]}">${k}</b></td><td colspan="10">no settled bets yet</td></tr>`).join('');
        const curves = st.filter(([, s]) => s.n).map(([k, s]) => ({ name: k, color: colors[k], points: s.curve }));
        const f = st.find(([k]) => k === 'FROZEN_HTD')[1];
        const c = st.find(([k]) => k === 'CONTROL_HTD')[1];
        const dayRows = f.n ? f.days.slice().reverse().map(([d, x]) => {
            const cd = c.days ? (c.days.find(([dd]) => dd === d) || [null, null])[1] : null;
            return `<tr><td>${d}</td><td>${x.n}</td><td>${fmtPct(x.wins / x.n, 1)}</td>
              <td style="color:${x.pnl >= 0 ? '#1a7f37' : '#cf222e'}">${fmtNum(x.pnl)}</td><td>${fmtPct(x.pnl / x.staked)}</td>
              <td>${cd ? fmtPct(cd.pnl / cd.staked) : '-'}</td></tr>`;
        }).join('') : '';
        return `<table><tr><th>Strategy</th><th>Bets</th><th>Hit</th><th>Break-even</th><th>P&amp;L (units)</th><th>ROI</th>
            <th>95% CI of ROI</th><th>z</th><th>+Days</th><th>Worst day</th><th>Max DD</th></tr>${rows}</table>
            <h3>Cumulative profit (1-unit flat stakes)</h3>${svgCurve(curves)}
            <h3>Daily results - FROZEN_HTD</h3><table><tr><th>Day (UTC)</th><th>Bets</th><th>Hit</th><th>P&amp;L</th><th>ROI</th><th>Control ROI</th></tr>${dayRows}</table>`;
    };
    const v = verdict(stats(db, 'FROZEN_HTD', 'forward'));
    const w = nextWindow();
    const stale = info.latestMatch && Date.now() - info.latestMatch > 30 * 60 * 1000;
    const up = upcoming(db, 30).map((u) => `<tr><td>${localTime(u.kickoff_ts)}</td><td>${u.home_team} v ${u.away_team}</td><td>${u.odds.toFixed(2)}</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="120">
<title>HT Draw paper trading</title><style>
body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#1f2328;max-width:1150px}
table{border-collapse:collapse;width:100%;margin:8px 0 18px;font-size:13px}th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:right}
th{background:#f6f8fa}td:first-child,th:first-child{text-align:left}.box{padding:14px 18px;border-radius:8px;color:#fff;margin:12px 0}
.warn{background:#fff8c5;border:1px solid #d4a72c;padding:10px 14px;border-radius:6px}small{color:#57606a}
</style></head><body>
<h1>HT Draw 6-hour cycle &mdash; paper trading</h1>
<p>Updated ${localTime(Date.now())} &middot; forward test since ${GO_LIVE_ISO} &middot; newest match ${info.latestMatch ? localTime(info.latestMatch) : '-'} &middot; page auto-refreshes every 2 min</p>
${stale ? `<p class="warn"><b>Scraper appears stopped:</b> newest match is ${((Date.now() - info.latestMatch) / 3600000).toFixed(1)} hours old. Start the SportyBet archive scraper so the forward test can collect data.</p>` : ''}
<div class="box" style="background:${v.color}"><b>${v.label}</b> &mdash; ${v.text}</div>
<p><b>Bet window:</b> ${w.active ? 'ACTIVE until ' + localTime(w.until) : 'closed &mdash; next opens ' + localTime(w.from)} (your local time). Windows (UTC): 03-06, 09-12, 15-18, 21-24.</p>
<h2>Forward test (new data &mdash; the only numbers that count)</h2>${section('forward')}
<h2>Next qualifying matches (paper bet: Half-Time Draw)</h2><table><tr><th>Kick-off</th><th>Match</th><th>HT Draw odds</th></tr>${up || '<tr><td colspan="3">none pending</td></tr>'}</table>
<h2>Backtest (discovery data &mdash; optimistic by construction)</h2>${section('backtest')}
<p><small>Break-even = average 1/odds; the strategy profits only if Hit is above it. z &gt; 2 with 15,000+ forward bets is the bar for "confirmed".
Virtual football is an RNG product; past patterns may disappear at any time, and the operator can change the engine or odds without notice.</small></p>
</body></html>`;
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportPath, html, 'utf8');
}

// ---------------------------------------------------------------- main
function runOnce() {
    const { src, db } = openDbs();
    try {
        const info = sync(src, db);
        printReport(db, info);
        writeHtml(db, info);
    } finally { src.close(); db.close(); }
}

if (require.main === module) {
    runOnce();
    if (WATCH) {
        console.log(`Watching - re-syncing every ${WATCH_INTERVAL_MS / 60000} minutes. Ctrl+C to stop.`);
        setInterval(() => { try { runOnce(); } catch (e) { console.error('[paper_trader] sync failed:', e.message); } }, WATCH_INTERVAL_MS);
    }
}

module.exports = { sync, stats, verdict, nextWindow, STRATEGIES, GO_LIVE_ISO, FROZEN_POSITIONS };
