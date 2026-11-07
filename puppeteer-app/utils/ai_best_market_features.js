'use strict';

// One market registry for training, inference and settlement. Prices must be
// captured for the actual fixture; no typical-odds substitutions are permitted.
const { resolveMarket, devigGroup } = require('./edge_gate');
const MARKETS = ['Home Win', 'Draw', 'Away Win', 'Both Teams to Score (GG)',
    'Both Teams NOT to Score (No GG)', 'Over 1.5 Goals', 'Under 1.5 Goals',
    'Over 2.5 Goals', 'Under 2.5 Goals', 'Over 3.5 Goals', 'Under 3.5 Goals',
    ...['11','1X','12','X1','XX','X2','21','2X','22'].map(s => `HT/FT ${s[0]}/${s[1]}`), '1X', 'X2', '12'];
const PROBS = ['homeWinProb','drawProb','awayWinProb','over15Prob','over25Prob',
    'over35Prob','ggProb','htft11Prob','htft1XProb','htft12Prob','htftX1Prob',
    'htftXXProb','htftX2Prob','htft21Prob','htft2XProb','htft22Prob'];
const SCHEMA_VERSION = 1;
const HIGH_CHANCE_SCHEMA_VERSION = 2;
function enginePolicy(engine, ai = {}, contextFeatures = false) {
    const key = engine === 'ai_best' ? 'ai_best_pick' : engine === 'high_chance' ? 'high_value' : engine;
    const aliases = { 'Both Teams to Score': 'Both Teams to Score (GG)', GG: 'Both Teams to Score (GG)', BTTS: 'Both Teams to Score (GG)' };
    const policy = { engine, schemaVersion: engine === 'high_chance' ? HIGH_CHANCE_SCHEMA_VERSION : SCHEMA_VERSION,
        markets: engine === 'high_chance' ? ['Over 2.5 Goals', 'Both Teams to Score (GG)'] : MARKETS,
        blockedMarkets: [...new Set((ai.blockedMarkets?.[key] || []).map(m => aliases[m] || m))].sort(),
        minOdds: engine === 'safest' ? 1.000001 : engine === 'high_chance' ? 1.65 : Number(ai.highRiskMinOdds) || 3.3,
        maxOdds: engine === 'high_chance' ? 3.5 : 100,
        midnightPaused: engine !== 'safest', policyVersion: 'wat-midnight-v1' };
    return contextFeatures ? {...policy,schemaVersion:policy.schemaVersion+2,contextFeatures:true} : policy;
}
function object(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value) || {}; } catch { return {}; } }
function score(value) { return /^\d+:\d+$/.test(value || '') ? value.split(':').map(Number) : null; }
function scope(row) { return String(row.season_name || '').replace(/\s*-?\s*(Week|Round)\s+\d+.*$/i, '').trim().toLowerCase(); }
function marketEntry(market) {
    const extra = { '1X': ['dc1x', (h,a) => h >= a, p => Number(p.homeWinProb) + Number(p.drawProb)],
        'X2': ['x2', (h,a) => h <= a, p => Number(p.awayWinProb) + Number(p.drawProb)],
        '12': ['dc12', (h,a) => h !== a, p => Number(p.homeWinProb) + Number(p.awayWinProb)] }[market];
    return extra ? { group: 'double_chance', def: { odds: o => o[extra[0]], win: extra[1], prob: extra[2] } } : resolveMarket(market);
}
function fairPrice(entry, market, odds) {
    if (entry.group !== 'double_chance') return devigGroup(entry.group, odds)?.[market];
    const f = devigGroup('1x2', odds);
    if (!f) return null;
    return market === '1X' ? f['Home Win'] + f.Draw : market === 'X2' ? f['Away Win'] + f.Draw : f['Home Win'] + f['Away Win'];
}
function outcome(market, ft, ht) {
    const f = score(ft), h = score(ht), entry = marketEntry(market);
    if (!f || !entry) return null;
    return entry.def.win(f[0], f[1], h?.[0] ?? null, h?.[1] ?? null);
}
const outcomeCache = new WeakMap();
function historyOutcome(row, index) {
    if (!outcomeCache.has(row)) outcomeCache.set(row, MARKETS.map(m => outcome(m, row.actual_score, row.actual_ht_score)));
    return outcomeCache.get(row)[index];
}
function candidates(row, history = [], minOdds = 3.3, policy = null, context = null) {
    const p = object(row.predicted_probs), odds = object(row.bookmaker_odds);
    const sameScope = history.filter(r => scope(r) === scope(row) &&
        Number(r.kickoff_timestamp) < Number(row.kickoff_timestamp)).slice(-250);
    const hour = new Date(Number(row.kickoff_timestamp)).getUTCHours();
    const result = [];
    const extra = policy?.contextFeatures ? (context || require('./match_context_features').MatchContext.fromHistory(history,Number(row.kickoff_timestamp))).features(row) : [];
    for (let i = 0; i < MARKETS.length; i++) {
        const market = MARKETS[i], e = marketEntry(market), price = Number(e.def.odds(odds));
        if (policy && (!policy.markets.includes(market) || policy.blockedMarkets.includes(market))) continue;
        if (!Number.isFinite(price) || price < minOdds || price > (policy?.maxOdds || 100)) continue;
        const fair = fairPrice(e, market, odds), raw = e.def.prob(p);
        if (!Number.isFinite(fair) || !Number.isFinite(raw) || raw < 0 || raw > 100) continue;
        const recent = sameScope.map(r => historyOutcome(r, i)).filter(x => x !== null);
        const rate = n => { const a = recent.slice(-n); return (a.filter(Boolean).length + fair * 20) / (a.length + 20); };
        const vector = [raw / 100, fair, Math.log(price), raw / 100 - fair,
            rate(50), rate(250), recent.length / 250,
            Math.sin(hour * Math.PI / 12), Math.cos(hour * Math.PI / 12),
            (Number(row.round_number) || 0) / 50,
            ...PROBS.map(k => Math.max(0, Math.min(1, (Number(p[k]) || 0) / 100))),
            ...MARKETS.map((_, j) => i === j ? 1 : 0)];
        if (policy?.engine === 'high_chance') {
            // Earlier results only: learn from forecast errors and price/team contexts,
            // never assume a loss makes the next fixture more likely to win.
            const past = sameScope.slice(-100).map(r => ({ row: r, y: historyOutcome(r, i),
                raw: e.def.prob(object(r.predicted_probs)) / 100,
                price: Number(e.def.odds(object(r.bookmaker_odds))) })).filter(r => r.y !== null);
            const residual = past.filter(r => Number.isFinite(r.raw));
            const errors = residual.map(r => Number(r.y) - r.raw);
            const team = past.filter(r => r.row.home_team === row.home_team || r.row.away_team === row.away_team);
            const band = past.filter(r => r.price > 1 && Math.abs(Math.log(r.price / price)) < .15);
            const shrink = a => (a.filter(r => r.y).length + fair * 20) / (a.length + 20);
            vector.push(errors.reduce((s,v)=>s+v,0)/(errors.length+20),
                errors.reduce((s,v)=>s+v*v,0)/(errors.length+20), residual.length/100,
                shrink(team), team.length/100, shrink(band), band.length/100);
        }
        vector.push(...extra);
        result.push({ market, marketIndex: i, match: row, price, fair, features: vector,
            label: outcome(market, row.actual_score, row.actual_ht_score), scope: scope(row) });
    }
    return result;
}
function buildDataset(rows, minOdds = 3.3, policy = null, trainingStride = 1) {
    const ordered = [...rows].filter(r => Number(r.kickoff_timestamp) > 0 && score(r.actual_score))
        .sort((a,b) => a.kickoff_timestamp - b.kickoff_timestamp || a.id - b.id);
    const history = new Map(), groups = new Map(), seen = new Set(), entries = [];
    const context = policy?.contextFeatures ? new (require('./match_context_features').MatchContext)() : null;
    for (const row of ordered) {
        const key = [scope(row), row.kickoff_timestamp, row.home_team, row.away_team].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        if (!groups.has(row.kickoff_timestamp)) groups.set(row.kickoff_timestamp, []);
        groups.get(row.kickoff_timestamp).push(row);
    }
    const times = [...groups.keys()], cutoffs = [.60,.70,.80].map(f=>times[Math.floor(times.length*f)]);
    let groupIndex = 0;
    for (const batch of groups.values()) {
        // Same-kickoff outcomes cannot become features for each other.
        // Fit/calibration/tuning can be sampled for bounded memory; the entire
        // contiguous final audit is retained so staking sequences stay genuine.
        const include = trainingStride <= 1 || groupIndex % trainingStride === 0 || batch[0].kickoff_timestamp >= cutoffs[2];
        groupIndex++;
        for (const row of include ? batch : []) {
            const past = history.get(scope(row)) || [];
            for (const c of candidates(row, past, minOdds, policy, context)) if (c.label !== null) {
                entries.push({ features: c.features, label: Number(c.label), market: c.marketIndex,
                    price: c.price, fair: c.fair, id: row.id, kickoff: row.kickoff_timestamp,
                    round: `${scope(row)}|${row.kickoff_timestamp}|${row.round_number}`, scope: c.scope });
            }
        }
        if(context)context.ingestBatch(batch);
        for (const row of batch) {
            const key = scope(row), past = history.get(key) || [];
            past.push(row); history.set(key, past.slice(-250));
        }
    }
    return { schema_version: policy?.schemaVersion || SCHEMA_VERSION, engine_policy: policy, markets: MARKETS, entries,
        split_cutoffs: cutoffs, training_stride: trainingStride, source_fixtures: ordered.length };
}
function loadHistory(db, before = Date.now(), contextFeatures = false) {
    return db.prepare(`SELECT id, season_name, round_number, home_team, away_team, predicted_probs, bookmaker_odds, kickoff_timestamp, actual_score, actual_ht_score
        FROM live_predictions WHERE scored_status = 1 AND actual_score IS NOT NULL
        AND kickoff_timestamp < ? ORDER BY kickoff_timestamp DESC, id DESC LIMIT ?`).all(before,contextFeatures?5000:1500).reverse();
}
module.exports = { MARKETS, INPUT_PROB_KEYS: [...PROBS, 'noGgProb', 'under15Prob', 'under25Prob', 'under35Prob'], SCHEMA_VERSION, HIGH_CHANCE_SCHEMA_VERSION, enginePolicy, candidates, buildDataset, loadHistory, outcome, scope };

if (require.main === module) {
    const fs = require('fs');
    const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    let policy = null;
    if (process.argv[5]) {
        const path = require('path');
        let ai = {}; try { ai = JSON.parse(fs.readFileSync(path.join(__dirname, '../browser-config.json'), 'utf8')).ai || {}; } catch {}
        policy = enginePolicy(process.argv[5], ai, process.argv[6] === 'context');
    }
    const data=buildDataset(rows, policy?.minOdds || Number(process.argv[4]) || 3.3, policy, rows.length < 12000 ? 1 : Number(process.argv[7]) || 1);
    const {entries,...metadata}=data, fd=fs.openSync(process.argv[3],'w');
    try{
        fs.writeSync(fd,JSON.stringify(metadata).slice(0,-1)+',"entries":[');
        for(let i=0;i<entries.length;i+=1000)fs.writeSync(fd,(i?',':'')+JSON.stringify(entries.slice(i,i+1000)).slice(1,-1));
        fs.writeSync(fd,']}');
    }finally{fs.closeSync(fd);}
}
