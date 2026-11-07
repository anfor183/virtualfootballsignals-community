#!/usr/bin/env node
/**
 * retrain_htft_calibration.js
 * Uses 20,413 historical predictions + actual HT/FT outcomes
 * to build isotonic regression calibration tables for all 9 HT/FT markets.
 * Writes to utils/htft_calibration_tables.js
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { resolveDatabasePath } = require('./utils/path_resolver');
const DB_PATH = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const OUT_PATH = path.join(__dirname, 'utils/htft_calibration_tables.js');

const HTFT_KEYS = [
    'htft11Prob','htft1XProb','htft12Prob',
    'htftX1Prob','htftXXProb','htftX2Prob',
    'htft21Prob','htft2XProb','htft22Prob'
];
const KEY_TO_OUTCOME = {
    htft11Prob:'11', htft1XProb:'1X', htft12Prob:'12',
    htftX1Prob:'X1', htftXXProb:'XX', htftX2Prob:'X2',
    htft21Prob:'21', htft2XProb:'2X', htft22Prob:'22'
};

// Isotonic Regression (Pool Adjacent Violators) 
function isotonicRegression(pairs) {
    const sorted = [...pairs].sort((a, b) => a.x - b.x);
    const nBuckets = Math.min(20, Math.floor(sorted.length / 10));
    if (nBuckets < 2) return [];
    const bucketSize = Math.floor(sorted.length / nBuckets);
    
    let blocks = [];
    for (let i = 0; i < nBuckets; i++) {
        const start = i * bucketSize;
        const end = i === nBuckets - 1 ? sorted.length : (i + 1) * bucketSize;
        const slice = sorted.slice(start, end);
        const mean_x = slice.reduce((a, s) => a + s.x, 0) / slice.length;
        const mean_y = slice.reduce((a, s) => a + s.y, 0) / slice.length;
        blocks.push({ mean_x, mean_y, n: slice.length });
    }
    
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < blocks.length - 1; i++) {
            if (blocks[i].mean_y > blocks[i+1].mean_y) {
                const merged = {
                    n: blocks[i].n + blocks[i+1].n,
                    mean_x: (blocks[i].mean_x * blocks[i].n + blocks[i+1].mean_x * blocks[i+1].n) / (blocks[i].n + blocks[i+1].n),
                    mean_y: (blocks[i].mean_y * blocks[i].n + blocks[i+1].mean_y * blocks[i+1].n) / (blocks[i].n + blocks[i+1].n)
                };
                blocks.splice(i, 2, merged);
                changed = true;
                break;
            }
        }
    }
    return blocks;
}

function applyCalib(rawPct, table) {
    if (!table || !table.length) return rawPct;
    if (rawPct <= table[0].mean_x) return table[0].mean_y * 100;
    if (rawPct >= table[table.length-1].mean_x) return table[table.length-1].mean_y * 100;
    for (let i = 0; i < table.length - 1; i++) {
        if (rawPct >= table[i].mean_x && rawPct <= table[i+1].mean_x) {
            const t = (rawPct - table[i].mean_x) / (table[i+1].mean_x - table[i].mean_x);
            return (table[i].mean_y + t * (table[i+1].mean_y - table[i].mean_y)) * 100;
        }
    }
    return rawPct;
}

console.log('Loading training data...');
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
    SELECT predicted_probs, actual_ht_score, actual_score
    FROM historical_market_predictions
    WHERE actual_ht_score IS NOT NULL AND actual_ht_score != ''
      AND actual_score IS NOT NULL AND actual_score != ''
      AND predicted_probs IS NOT NULL
`).all();
console.log('Training rows:', rows.length);

const pairsByKey = {};
HTFT_KEYS.forEach(k => pairsByKey[k] = []);

rows.forEach(r => {
    try {
        const p = JSON.parse(r.predicted_probs);
        const [htH, htA] = r.actual_ht_score.split(':').map(Number);
        const [ftH, ftA] = r.actual_score.split(':').map(Number);
        if (isNaN(htH) || isNaN(ftH)) return;
        const htResult = htH > htA ? '1' : htH < htA ? '2' : 'X';
        const ftResult = ftH > ftA ? '1' : ftH < ftA ? '2' : 'X';
        const actual = htResult + ftResult;
        HTFT_KEYS.forEach(k => {
            const raw = p[k];
            if (raw != null) pairsByKey[k].push({ x: raw, y: actual === KEY_TO_OUTCOME[k] ? 1 : 0 });
        });
    } catch(e) {}
});

db.close();

const tables = {};
const diagnostics = {};

HTFT_KEYS.forEach(k => {
    const pairs = pairsByKey[k];
    const table = isotonicRegression(pairs);
    tables[k] = table;
    
    const avgBefore = pairs.reduce((a,p)=>a+p.x,0)/pairs.length;
    const avgAfter  = pairs.reduce((a,p)=>a+applyCalib(p.x,table),0)/pairs.length;
    const avgActual = pairs.reduce((a,p)=>a+p.y,0)/pairs.length*100;
    diagnostics[k] = { n: pairs.length, avgBefore, avgAfter, avgActual,
        biasBefore: avgBefore-avgActual, biasAfter: avgAfter-avgActual };
    console.log(`${k}: bias ${(avgBefore-avgActual).toFixed(1)}pp → ${(avgAfter-avgActual).toFixed(1)}pp  (${table.length} calibration points)`);
});

// Write output module
const moduleCode = `/**
 * htft_calibration_tables.js  —  AUTO-GENERATED
 * retrain_htft_calibration.js — ${new Date().toISOString()}
 * Trained on ${rows.length} historical matches with actual HT+FT outcomes.
 * Uses isotonic regression (PAVA) calibration.
 */

const HTFT_CALIBRATION_TABLES = ${JSON.stringify(tables, null, 2)};

const HTFT_KEYS = ${JSON.stringify(HTFT_KEYS)};

function calibrateHtftProbs(rawProbs) {
    const result = { ...rawProbs };
    for (const key of HTFT_KEYS) {
        if (rawProbs[key] == null) continue;
        const rawPct = rawProbs[key];
        const table = HTFT_CALIBRATION_TABLES[key];
        if (!table || !table.length) continue;
        if (rawPct <= table[0].mean_x) { result[key] = table[0].mean_y * 100; continue; }
        if (rawPct >= table[table.length-1].mean_x) { result[key] = table[table.length-1].mean_y * 100; continue; }
        for (let i = 0; i < table.length - 1; i++) {
            if (rawPct >= table[i].mean_x && rawPct <= table[i+1].mean_x) {
                const t = (rawPct - table[i].mean_x) / (table[i+1].mean_x - table[i].mean_x);
                result[key] = (table[i].mean_y + t * (table[i+1].mean_y - table[i].mean_y)) * 100;
                break;
            }
        }
    }
    return result;
}

function getBestHtftBet(calibratedProbs, bookOdds, minEV = 5) {
    const PROB_TO_ODDS = {
        htft11Prob:'htft11', htft1XProb:'htft1X', htft12Prob:'htft12',
        htftX1Prob:'htftX1', htftXXProb:'htftXX', htftX2Prob:'htftX2',
        htft21Prob:'htft21', htft2XProb:'htft2X', htft22Prob:'htft22'
    };
    const MARKET_NAMES = {
        htft11:'HT/FT 1/1', htft1X:'HT/FT 1/X', htft12:'HT/FT 1/2',
        htftX1:'HT/FT X/1', htftXX:'HT/FT X/X', htftX2:'HT/FT X/2',
        htft21:'HT/FT 2/1', htft2X:'HT/FT 2/X', htft22:'HT/FT 2/2'
    };
    let best = null;
    for (const [probKey, oddsKey] of Object.entries(PROB_TO_ODDS)) {
        const calibProb = calibratedProbs[probKey];
        const bookOdd = bookOdds[oddsKey];
        if (calibProb == null || !bookOdd || bookOdd <= 1) continue;
        const calibProbDec = calibProb / 100;
        const ev = (calibProbDec * bookOdd - 1) * 100;
        if (ev < minEV) continue;
        if (!best || ev > best.ev) {
            best = { market: MARKET_NAMES[oddsKey], oddsKey, probKey, calibratedProb: calibProb, bookOdd, ev, breakEven: (1/bookOdd)*100 };
        }
    }
    return best;
}

module.exports = { HTFT_CALIBRATION_TABLES, calibrateHtftProbs, getBestHtftBet };
`;

fs.writeFileSync(OUT_PATH, moduleCode, 'utf8');
console.log('\n✅ Written to:', OUT_PATH);
console.log('\n=== DIAGNOSTICS ===');
HTFT_KEYS.forEach(k => {
    const d = diagnostics[k];
    console.log(`${k.padEnd(18)} n=${d.n} avgModel=${d.avgBefore.toFixed(1)}% calibrated=${d.avgAfter.toFixed(1)}% actual=${d.avgActual.toFixed(1)}% bias: ${d.biasBefore.toFixed(1)}pp→${d.biasAfter.toFixed(1)}pp`);
});
