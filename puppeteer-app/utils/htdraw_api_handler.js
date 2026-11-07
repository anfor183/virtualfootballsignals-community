/**
 * htdraw_api_handler.js
 * 
 * Provides live statistical calculations and a modern interactive React dashboard
 * for the Half-Time Draw 6-Hour Cycle forward paper test.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const GO_LIVE = new Date('2026-10-05T00:00:00Z').getTime();
const VERDICT_MIN_BETS = 15000;
const FROZEN_POSITIONS = [3, 4, 5];

let cachedDb = null;
let cachedDbPath = null;

function getPaperDb(baseDir) {
    const dbPath = path.join(baseDir, 'databases/paper_trading.db');
    if (cachedDb && cachedDbPath === dbPath) {
        return cachedDb;
    }
    if (!fs.existsSync(dbPath)) {
        return null;
    }
    try {
        cachedDb = new Database(dbPath, { readonly: true, fileMustExist: true });
        cachedDb.pragma('busy_timeout = 5000');
        cachedDbPath = dbPath;
        return cachedDb;
    } catch (e) {
        console.error('[htdraw_api_handler] Error opening paper_trading.db:', e.message);
        return null;
    }
}

function calcStatsForStrategy(db, strategy, phase) {
    try {
        const rows = db.prepare(`
            SELECT kickoff_ts ts, odds, stake, pnl, status 
            FROM paper_bets
            WHERE strategy = ? AND phase = ? AND status IN ('won','lost') 
            ORDER BY kickoff_ts ASC
        `).all(strategy, phase);

        const n = rows.length;
        if (!n) {
            return {
                n: 0, staked: 0, pnl: 0, roi: 0, wins: 0, hitRate: 0, impliedRate: 0,
                maxDD: 0, z: 0, ciLow: 0, ciHigh: 0, days: [], curve: []
            };
        }

        let staked = 0, pnl = 0, wins = 0, peak = 0, maxDD = 0, sumSq = 0, impl = 0;
        const daily = new Map();
        const curve = [];

        for (const r of rows) {
            staked += r.stake;
            pnl += r.pnl;
            sumSq += r.pnl * r.pnl;
            impl += 1 / r.odds;
            if (r.status === 'won') wins++;

            peak = Math.max(peak, pnl);
            maxDD = Math.max(maxDD, peak - pnl);

            const day = new Date(r.ts).toISOString().slice(0, 10);
            if (!daily.has(day)) daily.set(day, { n: 0, pnl: 0, staked: 0, wins: 0 });
            const c = daily.get(day);
            c.n++;
            c.pnl += r.pnl;
            c.staked += r.stake;
            if (r.status === 'won') c.wins++;

            curve.push({ ts: r.ts, pnl: Number(pnl.toFixed(2)) });
        }

        const mean = pnl / n;
        const sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-12));
        const se = sd / Math.sqrt(n);
        const roi = pnl / staked;

        const days = [...daily.entries()].map(([date, d]) => ({
            date,
            n: d.n,
            wins: d.wins,
            pnl: Number(d.pnl.toFixed(2)),
            staked: Number(d.staked.toFixed(1)),
            hitRate: Number((d.wins / d.n).toFixed(4)),
            roi: Number((d.pnl / d.staked).toFixed(4))
        })).sort((a, b) => (a.date < b.date ? -1 : 1));

        return {
            n,
            staked: Number(staked.toFixed(1)),
            pnl: Number(pnl.toFixed(2)),
            roi: Number(roi.toFixed(4)),
            wins,
            hitRate: Number((wins / n).toFixed(4)),
            impliedRate: Number((impl / n).toFixed(4)),
            maxDD: Number(maxDD.toFixed(2)),
            z: Number((mean / se).toFixed(2)),
            ciLow: Number(((mean - 1.96 * se) / (staked / n)).toFixed(4)),
            ciHigh: Number(((mean + 1.96 * se) / (staked / n)).toFixed(4)),
            days,
            curve: curve.length > 500 
                ? curve.filter((_, i) => i % Math.ceil(curve.length / 500) === 0 || i === curve.length - 1)
                : curve
        };
    } catch (err) {
        console.error(`[htdraw_api_handler] Error calculating stats for ${strategy} (${phase}):`, err.message);
        return { n: 0, error: err.message };
    }
}

function getCycleStatus() {
    const now = Date.now();
    const utcHours = new Date(now).getUTCHours();
    const utcMinutes = new Date(now).getUTCMinutes();
    const utcSeconds = new Date(now).getUTCSeconds();
    const cyclePos = utcHours % 6;
    const isWindowActive = FROZEN_POSITIONS.includes(cyclePos);

    let minutesUntilChange = 0;
    if (isWindowActive) {
        // Window active: ends when cycle reaches 6 (next pos 0)
        const hoursLeft = (6 - cyclePos - 1);
        minutesUntilChange = hoursLeft * 60 + (60 - utcMinutes);
    } else {
        // Window closed: opens at pos 3
        const hoursLeft = (3 - cyclePos - 1);
        minutesUntilChange = hoursLeft * 60 + (60 - utcMinutes);
    }

    return {
        timestamp: new Date(now).toISOString(),
        utcHours,
        utcMinutes,
        cyclePos,
        isWindowActive,
        minutesUntilChange,
        activeHoursUtc: '03:00-06:00, 09:00-12:00, 15:00-18:00, 21:00-24:00 UTC',
        statusLabel: isWindowActive ? 'WINDOW ACTIVE' : 'WINDOW CLOSED'
    };
}

function getPaperStatsData(baseDir) {
    const db = getPaperDb(baseDir);
    if (!db) {
        return {
            success: false,
            error: 'paper_trading.db not found or not accessible yet'
        };
    }

    const cycle = getCycleStatus();
    const strategies = ['FROZEN_HTD', 'ADAPTIVE_HTD', 'FROZEN_X1X2', 'CONTROL_HTD'];
    const forward = {};
    const backtest = {};

    for (const strat of strategies) {
        forward[strat] = calcStatsForStrategy(db, strat, 'forward');
        backtest[strat] = calcStatsForStrategy(db, strat, 'backtest');
    }

    // Recent settled
    let recentSettled = [];
    try {
        recentSettled = db.prepare(`
            SELECT kickoff_ts, season_name, round_number, home_team, away_team, 
                   odds, status, pnl, ht_score, ft_score, market
            FROM paper_bets
            WHERE strategy = 'FROZEN_HTD' AND status IN ('won','lost')
            ORDER BY kickoff_ts DESC
            LIMIT 20
        `).all().map(r => ({
            ...r,
            kickoff_iso: new Date(r.kickoff_ts).toISOString(),
            won: r.status === 'won'
        }));
    } catch (_) {}

    // Upcoming pending
    let upcoming = [];
    try {
        upcoming = db.prepare(`
            SELECT kickoff_ts, season_name, round_number, home_team, away_team, 
                   odds, cycle_pos, market
            FROM paper_bets
            WHERE strategy = 'FROZEN_HTD' AND status = 'pending' AND kickoff_ts >= ?
            ORDER BY kickoff_ts ASC
            LIMIT 15
        `).all(Date.now() - 60000).map(r => ({
            ...r,
            kickoff_iso: new Date(r.kickoff_ts).toISOString()
        }));
    } catch (_) {}

    const primaryForward = forward['FROZEN_HTD'] || { n: 0 };
    let verdict = {
        label: 'WAITING FOR DATA',
        color: '#6b7280',
        text: 'Accumulating forward test bets.'
    };

    if (primaryForward.n > 0) {
        const progressPct = ((primaryForward.n / VERDICT_MIN_BETS) * 100).toFixed(1);
        if (primaryForward.n >= VERDICT_MIN_BETS && primaryForward.ciLow > 0) {
            verdict = {
                label: 'EDGE CONFIRMED',
                color: '#16a34a',
                text: `Target reached (${primaryForward.n.toLocaleString()} bets). Lower 95% CI is +${(primaryForward.ciLow * 100).toFixed(2)}%. Edge validated.`
            };
        } else if (primaryForward.n >= VERDICT_MIN_BETS && primaryForward.ciHigh < 0) {
            verdict = {
                label: 'EDGE REJECTED',
                color: '#dc2626',
                text: `Target reached (${primaryForward.n.toLocaleString()} bets). Strategy failed to demonstrate a positive edge.`
            };
        } else {
            verdict = {
                label: 'KEEP COLLECTING',
                color: '#2563eb',
                text: `Collected ${primaryForward.n.toLocaleString()} / ${VERDICT_MIN_BETS.toLocaleString()} bets (${progressPct}%). Confidence intervals narrowing.`
            };
        }
    }

    return {
        success: true,
        generatedAt: new Date().toISOString(),
        targetBets: VERDICT_MIN_BETS,
        progressPercent: Number(((primaryForward.n / VERDICT_MIN_BETS) * 100).toFixed(2)),
        verdict,
        cycle,
        strategies: {
            forward,
            backtest
        },
        recentSettled,
        upcoming
    };
}

function getDashboardHtml(apiEndpoint = '/api/htdraw/stats') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HT Draw 6-Hour Cycle | Live Strategy Dashboard</title>
  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- React & ReactDOM -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <!-- Babel Standalone for inline JSX -->
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Outfit:wght@400;500;600;700;800&display=swap');
    body { font-family: 'Outfit', sans-serif; background-color: #0b0f19; color: #f3f4f6; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .glow-green { box-shadow: 0 0 20px -5px rgba(34, 197, 94, 0.35); }
    .glow-blue { box-shadow: 0 0 20px -5px rgba(59, 130, 246, 0.35); }
    .glow-purple { box-shadow: 0 0 20px -5px rgba(168, 85, 247, 0.35); }
  </style>
</head>
<body class="min-h-screen">
  <div id="root"></div>

  <script type="text/babel">
    const { useState, useEffect } = React;

    function SvgProfitCurve({ curve, color = '#3b82f6' }) {
      if (!curve || curve.length < 2) {
        return <div class="text-sm text-gray-500 py-12 text-center">Not enough data points yet to plot curve.</div>;
      }

      const values = curve.map(c => c.pnl);
      const min = Math.min(0, ...values);
      const max = Math.max(10, ...values);
      const range = max - min || 1;

      const width = 800;
      const height = 180;
      const padding = 15;

      const points = curve.map((c, i) => {
        const x = padding + (i / (curve.length - 1)) * (width - 2 * padding);
        const y = height - padding - ((c.pnl - min) / range) * (height - 2 * padding);
        return \`\${x.toFixed(1)},\${y.toFixed(1)}\`;
      }).join(' ');

      const zeroY = height - padding - ((0 - min) / range) * (height - 2 * padding);

      return (
        <div class="w-full overflow-hidden">
          <svg viewBox={\`0 0 \${width} \${height}\`} class="w-full h-44">
            <line x1={padding} y1={zeroY} x2={width - padding} y2={zeroY} stroke="#374151" stroke-dasharray="4 4" stroke-width="1.5" />
            <polyline fill="none" stroke={color} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points={points} />
          </svg>
          <div class="flex justify-between text-xs text-gray-500 mono px-2 mt-1">
            <span>Low: {min.toFixed(1)}u</span>
            <span>Zero Line</span>
            <span>Peak: +{max.toFixed(1)}u</span>
          </div>
        </div>
      );
    }

    function App() {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [lastFetchTime, setLastFetchTime] = useState(null);
      const [secondsAgo, setSecondsAgo] = useState(0);

      const fetchData = async () => {
        try {
          const res = await fetch('${apiEndpoint}');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const json = await res.json();
          if (json.success) {
            setData(json);
            setLastFetchTime(Date.now());
            setError(null);
          } else {
            setError(json.error || 'Failed to load data');
          }
        } catch (e) {
          setError(e.message);
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 12000); // Poll every 12 seconds
        return () => clearInterval(interval);
      }, []);

      useEffect(() => {
        const timer = setInterval(() => {
          if (lastFetchTime) {
            setSecondsAgo(Math.floor((Date.now() - lastFetchTime) / 1000));
          }
        }, 1000);
        return () => clearInterval(timer);
      }, [lastFetchTime]);

      if (loading && !data) {
        return (
          <div class="flex flex-col items-center justify-center min-h-screen text-gray-400">
            <div class="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p class="text-lg">Connecting to VPS Live Feed...</p>
          </div>
        );
      }

      if (error && !data) {
        return (
          <div class="flex flex-col items-center justify-center min-h-screen p-4">
            <div class="bg-red-950/50 border border-red-700/50 p-6 rounded-xl max-w-md text-center">
              <h2 class="text-xl font-bold text-red-400 mb-2">Connection Error</h2>
              <p class="text-sm text-gray-300 mb-4">{error}</p>
              <button onClick={fetchData} class="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-white font-medium text-sm transition">
                Retry Connection
              </button>
            </div>
          </div>
        );
      }

      const fHtd = data?.strategies?.forward?.FROZEN_HTD || {};
      const fX1X2 = data?.strategies?.forward?.FROZEN_X1X2 || {};
      const fCtrl = data?.strategies?.forward?.CONTROL_HTD || {};
      const cycle = data?.cycle || {};

      const isPositive = fHtd.pnl >= 0;

      return (
        <div class="max-w-7xl mx-auto px-4 py-6 md:py-8 space-y-6">
          {/* Header */}
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-gray-800">
            <div>
              <div class="flex items-center gap-3">
                <span class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
                <h1 class="text-2xl md:text-3xl font-extrabold tracking-tight">HT Draw 6-Hour Cycle Radar</h1>
                <span class="text-xs bg-blue-900/60 text-blue-300 font-semibold px-2.5 py-0.5 rounded-full border border-blue-700/50">
                  LIVE FORWARD TEST
                </span>
              </div>
              <p class="text-gray-400 text-sm mt-1">
                Real-time validation on live SportyBet Virtual matches from Ubuntu VPS (127.0.0.1)
              </p>
            </div>

            <div class="flex items-center gap-3 self-start md:self-auto">
              <div class="text-right text-xs text-gray-400 mono">
                <div>Updated <span class="text-emerald-400 font-bold">{secondsAgo}s ago</span></div>
                <div class="text-gray-500">Auto-refresh: 12s</div>
              </div>
              <button 
                onClick={fetchData}
                class="px-3.5 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs font-semibold text-gray-200 transition flex items-center gap-1.5"
              >
                <span>↻</span> Refresh
              </button>
            </div>
          </div>

          {/* Window Status Banner */}
          <div class={\`p-4 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 \${
            cycle.isWindowActive 
              ? 'bg-emerald-950/30 border-emerald-600/40 glow-green' 
              : 'bg-amber-950/20 border-amber-700/40'
          }\`}>
            <div class="flex items-center gap-3">
              <span class={\`text-2xl \${cycle.isWindowActive ? 'animate-bounce' : ''}\`}>
                {cycle.isWindowActive ? '🎯' : '⏳'}
              </span>
              <div>
                <div class="flex items-center gap-2">
                  <span class={\`font-bold tracking-wide text-sm \${cycle.isWindowActive ? 'text-emerald-400' : 'text-amber-400'}\`}>
                    {cycle.statusLabel}
                  </span>
                  <span class="text-xs text-gray-400 mono">• UTC Hour: {cycle.utcHours}:00 (Cycle Pos {cycle.cyclePos})</span>
                </div>
                <p class="text-xs text-gray-300 mt-0.5">
                  {cycle.isWindowActive 
                    ? 'Currently inside active betting window (Hours 3, 4, 5). New bets qualify!' 
                    : \`Resting phase. Next 3-hour window opens in \${cycle.minutesUntilChange} minutes.\`}
                </p>
              </div>
            </div>
            <div class="text-xs mono bg-gray-900/80 px-3 py-1.5 rounded-lg border border-gray-800 text-gray-300 self-start md:self-auto">
              Active Windows: <span class="text-blue-400">{cycle.activeHoursUtc}</span>
            </div>
          </div>

          {/* KPI Cards */}
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
              <span class="text-xs text-gray-400 font-semibold tracking-wider uppercase">Forward P&L (1u)</span>
              <div class={\`text-2xl md:text-3xl font-extrabold mt-1 mono \${isPositive ? 'text-emerald-400' : 'text-red-400'}\`}>
                {isPositive ? '+' : ''}{fHtd.pnl}u
              </div>
              <div class="text-xs text-gray-400 mt-1">
                ROI: <span class={\`font-bold \${isPositive ? 'text-emerald-400' : 'text-red-400'}\`}>
                  {(fHtd.roi * 100).toFixed(2)}%
                </span>
              </div>
            </div>

            <div class="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
              <span class="text-xs text-gray-400 font-semibold tracking-wider uppercase">Hit Rate vs Break-Even</span>
              <div class="text-2xl md:text-3xl font-extrabold mt-1 text-blue-400 mono">
                {(fHtd.hitRate * 100).toFixed(1)}%
              </div>
              <div class="text-xs text-gray-400 mt-1">
                Break-even: <span class="text-gray-300 font-mono">{(fHtd.impliedRate * 100).toFixed(1)}%</span>
                <span class="text-emerald-400 font-semibold ml-1">
                  ({((fHtd.hitRate - fHtd.impliedRate) * 100).toFixed(1)}% edge)
                </span>
              </div>
            </div>

            <div class="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
              <span class="text-xs text-gray-400 font-semibold tracking-wider uppercase">Bets Collected</span>
              <div class="text-2xl md:text-3xl font-extrabold mt-1 text-purple-400 mono">
                {fHtd.n} <span class="text-xs text-gray-500 font-normal">/ {data.targetBets}</span>
              </div>
              <div class="w-full bg-gray-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div 
                  class="bg-purple-500 h-full rounded-full transition-all duration-500" 
                  style={{ width: \`\${Math.min(100, data.progressPercent)}%\` }}
                ></div>
              </div>
              <div class="text-xs text-gray-400 mt-1 flex justify-between">
                <span>Progress</span>
                <span class="font-mono text-purple-300">{data.progressPercent}%</span>
              </div>
            </div>

            <div class="bg-gray-900/60 border border-gray-800 rounded-xl p-4">
              <span class="text-xs text-gray-400 font-semibold tracking-wider uppercase">Statistical Verdict</span>
              <div class="text-lg md:text-xl font-black mt-1 text-blue-400 uppercase tracking-tight">
                {data.verdict.label}
              </div>
              <div class="text-xs text-gray-400 mt-1">
                95% CI: <span class="mono text-gray-300">[{(fHtd.ciLow * 100).toFixed(1)}%, {(fHtd.ciHigh * 100).toFixed(1)}%]</span>
              </div>
            </div>
          </div>

          {/* Equity Curve & Strategy Comparison */}
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Chart */}
            <div class="lg:col-span-2 bg-gray-900/50 border border-gray-800 rounded-xl p-5 flex flex-col justify-between">
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-bold text-base text-gray-200">Forward Cumulative Profit Curve (1-Unit Flat)</h3>
                <span class="text-xs mono text-gray-400 bg-gray-800/80 px-2 py-0.5 rounded">FROZEN_HTD</span>
              </div>
              <SvgProfitCurve curve={fHtd.curve} color="#3b82f6" />
              <p class="text-xs text-gray-500 mt-3 text-center">
                Flat 1-unit stake on every Half-Time Draw during hours {cycle.activeHoursUtc}. Zero Martingale, pure mathematical edge validation.
              </p>
            </div>

            {/* Daily Breakdown */}
            <div class="bg-gray-900/50 border border-gray-800 rounded-xl p-5 flex flex-col">
              <h3 class="font-bold text-base text-gray-200 mb-3">Daily Forward Breakdown</h3>
              <div class="overflow-y-auto max-h-60 space-y-2 pr-1">
                {fHtd.days && fHtd.days.length > 0 ? (
                  fHtd.days.map((d) => (
                    <div key={d.date} class="bg-gray-800/50 border border-gray-700/50 p-2.5 rounded-lg flex items-center justify-between text-xs">
                      <div>
                        <div class="font-bold text-gray-300 mono">{d.date}</div>
                        <div class="text-gray-400 text-xs mt-0.5">{d.wins}/{d.n} won ({(d.hitRate * 100).toFixed(1)}%)</div>
                      </div>
                      <div class="text-right">
                        <div class={\`font-black mono \${d.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                          {d.pnl >= 0 ? '+' : ''}{d.pnl}u
                        </div>
                        <div class="text-gray-400 text-xs">{(d.roi * 100).toFixed(1)}% ROI</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div class="text-xs text-gray-500 text-center py-8">No daily records yet.</div>
                )}
              </div>
              <div class="mt-auto pt-3 border-t border-gray-800/80 text-xs text-gray-400 flex justify-between">
                <span>Max Drawdown:</span>
                <span class="mono font-semibold text-amber-400">{fHtd.maxDD}u</span>
              </div>
            </div>
          </div>

          {/* Strategy Benchmarks Table */}
          <div class="bg-gray-900/50 border border-gray-800 rounded-xl p-5 overflow-hidden">
            <h3 class="font-bold text-base text-gray-200 mb-3">Active Forward Strategies vs Control Group</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-gray-800/60 text-gray-400 uppercase tracking-wider font-semibold">
                  <tr>
                    <th class="p-3">Strategy</th>
                    <th class="p-3">Description</th>
                    <th class="p-3">Bets</th>
                    <th class="p-3">Hit Rate</th>
                    <th class="p-3">Break-Even</th>
                    <th class="p-3">P&L (1u)</th>
                    <th class="p-3">ROI</th>
                    <th class="p-3">95% CI</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800">
                  <tr class="hover:bg-gray-800/30 font-medium">
                    <td class="p-3 font-bold text-blue-400">FROZEN_HTD</td>
                    <td class="p-3 text-gray-400">HT Draw in 6h cycle windows (our core edge)</td>
                    <td class="p-3 mono">{fHtd.n}</td>
                    <td class="p-3 mono font-semibold text-blue-300">{(fHtd.hitRate * 100).toFixed(1)}%</td>
                    <td class="p-3 mono text-gray-400">{(fHtd.impliedRate * 100).toFixed(1)}%</td>
                    <td class={\`p-3 mono font-bold \${fHtd.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {fHtd.pnl >= 0 ? '+' : ''}{fHtd.pnl}u
                    </td>
                    <td class={\`p-3 mono font-bold \${fHtd.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {(fHtd.roi * 100).toFixed(2)}%
                    </td>
                    <td class="p-3 mono text-gray-400">[{(fHtd.ciLow * 100).toFixed(1)}%, {(fHtd.ciHigh * 100).toFixed(1)}%]</td>
                  </tr>

                  <tr class="hover:bg-gray-800/30">
                    <td class="p-3 font-bold text-amber-400">FROZEN_X1X2</td>
                    <td class="p-3 text-gray-400">HT/FT X/1 + X/2 combined in 6h windows</td>
                    <td class="p-3 mono">{fX1X2.n}</td>
                    <td class="p-3 mono">{(fX1X2.hitRate * 100).toFixed(1)}%</td>
                    <td class="p-3 mono text-gray-400">{(fX1X2.impliedRate * 100).toFixed(1)}%</td>
                    <td class={\`p-3 mono font-bold \${fX1X2.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {fX1X2.pnl >= 0 ? '+' : ''}{fX1X2.pnl}u
                    </td>
                    <td class={\`p-3 mono \${fX1X2.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {(fX1X2.roi * 100).toFixed(2)}%
                    </td>
                    <td class="p-3 mono text-gray-400">[{(fX1X2.ciLow * 100).toFixed(1)}%, {(fX1X2.ciHigh * 100).toFixed(1)}%]</td>
                  </tr>

                  <tr class="hover:bg-gray-800/30 opacity-75">
                    <td class="p-3 font-bold text-red-400">CONTROL_HTD</td>
                    <td class="p-3 text-gray-400">Betting HT Draw on ALL 24 hours blindly (Baseline)</td>
                    <td class="p-3 mono">{fCtrl.n}</td>
                    <td class="p-3 mono">{(fCtrl.hitRate * 100).toFixed(1)}%</td>
                    <td class="p-3 mono text-gray-400">{(fCtrl.impliedRate * 100).toFixed(1)}%</td>
                    <td class={\`p-3 mono font-bold \${fCtrl.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {fCtrl.pnl >= 0 ? '+' : ''}{fCtrl.pnl}u
                    </td>
                    <td class={\`p-3 mono \${fCtrl.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}\`}>
                      {(fCtrl.roi * 100).toFixed(2)}%
                    </td>
                    <td class="p-3 mono text-gray-400">[{(fCtrl.ciLow * 100).toFixed(1)}%, {(fCtrl.ciHigh * 100).toFixed(1)}%]</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Settled Feed */}
          <div class="bg-gray-900/50 border border-gray-800 rounded-xl p-5">
            <h3 class="font-bold text-base text-gray-200 mb-3">Live Feed: Recent Settled Matches (FROZEN_HTD)</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-gray-800/60 text-gray-400 uppercase font-semibold">
                  <tr>
                    <th class="p-2.5">Time</th>
                    <th class="p-2.5">Match</th>
                    <th class="p-2.5">Odds</th>
                    <th class="p-2.5">HT Score</th>
                    <th class="p-2.5">FT Score</th>
                    <th class="p-2.5 text-right">Result</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800">
                  {data.recentSettled && data.recentSettled.length > 0 ? (
                    data.recentSettled.slice(0, 10).map((m, idx) => (
                      <tr key={idx} class="hover:bg-gray-800/30">
                        <td class="p-2.5 mono text-gray-400">
                          {new Date(m.kickoff_ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td class="p-2.5 font-medium text-gray-200">{m.home_team} vs {m.away_team}</td>
                        <td class="p-2.5 mono text-gray-300">{m.odds ? m.odds.toFixed(2) : '-'}</td>
                        <td class="p-2.5 mono font-bold text-blue-300">{m.ht_score || '-'}</td>
                        <td class="p-2.5 mono text-gray-400">{m.ft_score || '-'}</td>
                        <td class="p-2.5 text-right">
                          <span class={\`px-2 py-0.5 rounded text-xs font-bold \${
                            m.won 
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/60' 
                              : 'bg-red-950 text-red-300 border border-red-800/60'
                          }\`}>
                            {m.won ? '+ ' + (m.odds - 1).toFixed(2) + 'u WON' : '-1.00u LOST'}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="6" class="p-6 text-center text-gray-500">No settled bets recorded yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`;
}

module.exports = {
    getPaperStatsData,
    getDashboardHtml
};
