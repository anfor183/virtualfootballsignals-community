'use strict';

/**
 * test_edge_gate.js — run with:  node test_edge_gate.js
 * Verifies the evidence gate: de-vigging, label resolution, and that
 *   • a genuine, stable edge IS let through,
 *   • a zero-edge market and a time-unstable "edge" are BLOCKED,
 *   • the gate fails closed on unknown markets / unverifiable picks.
 * If databases/sportybet_archive.db exists it also prints a parity line against the real history.
 */

const assert = require('assert');
const gate = require('./utils/edge_gate');

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

const CFG = { ...gate.DEFAULTS, edgeGateMinGap: 0.05, edgeGateMinSample: 300, edgeGateZ: 1.2816 };

/** Build N rows for the Over/Under 2.5 pair: book prices 1.9/1.9 (fair 50/50), model says `modelOver`%. */
function makeRows(n, trueOverProbFn, modelOver = 60) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        const over = rnd() < trueOverProbFn(i, n);
        rows.push({
            probs: { over25Prob: modelOver },
            odds: { over25: 1.9, under25: 1.9 },
            score: over ? '2:1' : '1:0',
            htScore: '0:0'
        });
    }
    return rows;
}

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('edge_gate tests');

t('de-vig sums to 1 and removes margin', () => {
    const f = gate.devigGroup('1x2', { home: 2.0, draw: 3.5, away: 4.0 });
    const s = f['Home Win'] + f['Draw'] + f['Away Win'];
    assert(Math.abs(s - 1) < 1e-9);
    assert(f['Home Win'] < 0.5);              // raw 1/2.0 = 0.5 shrinks after de-vig
    assert.strictEqual(gate.devigGroup('1x2', { home: 2.0, draw: 3.5 }), null);   // missing quote -> null
});

t('label aliases resolve; unknown labels do not', () => {
    assert.strictEqual(gate.resolveMarket('Both Teams to Score').def.label, 'Both Teams to Score (GG)');
    assert.strictEqual(gate.resolveMarket('Both Teams NOT to Score (No GG)').def.label, 'Both Teams NOT to Score (No GG)');
    assert.strictEqual(gate.resolveMarket('HT/FT X/2').def.label, 'HT/FT X/2');
    assert.strictEqual(gate.resolveMarket('Home').def.label, 'Home Win');
    assert.strictEqual(gate.resolveMarket('Correct Score 2-1'), null);
});

t('zero-edge market (model overconfident, truth = 50%) is BLOCKED', () => {
    const ev = gate.computeEvidence(makeRows(4000, () => 0.5), CFG)['Over 2.5 Goals'];
    assert(ev.n >= 300);
    assert.strictEqual(ev.validated, false, JSON.stringify(ev));
});

t('genuine stable edge (truth = 62% in both halves) is let THROUGH', () => {
    const ev = gate.computeEvidence(makeRows(4000, () => 0.62), CFG)['Over 2.5 Goals'];
    assert.strictEqual(ev.validated, true, JSON.stringify(ev));
    assert(ev.roiPct > 5);
});

t('unstable "edge" (great first half, losing second half) is BLOCKED', () => {
    const ev = gate.computeEvidence(makeRows(4000, (i, n) => (i < n / 2 ? 0.66 : 0.40)), CFG)['Over 2.5 Goals'];
    assert.strictEqual(ev.validated, false, JSON.stringify(ev));
});

t('too few qualifying bets is BLOCKED even if lucky', () => {
    const ev = gate.computeEvidence(makeRows(100, () => 0.9), CFG)['Over 2.5 Goals'];
    assert.strictEqual(ev.validated, false);
    assert(/only/.test(ev.reason));
});

// DB-backed pick checks with a tiny in-memory stand-in for better-sqlite3
function fakeDb(rows) {
    return {
        name: 'fake-' + Math.random(),
        prepare() {
            return {
                all: () => rows.slice().reverse().map(r => ({
                    predicted_probs: JSON.stringify(r.probs), bookmaker_odds: JSON.stringify(r.odds),
                    actual_score: r.score, actual_ht_score: r.htScore
                }))
            };
        }
    };
}

t('check(): blocks unknown market and unverifiable pick (fails closed)', () => {
    const db = fakeDb(makeRows(4000, () => 0.62));
    assert.strictEqual(gate.check(db, 'safest', { market: 'Correct Score 2-1', match: {} }).allowed, false);
    assert.strictEqual(gate.check(db, 'safest', { market: 'Over 2.5 Goals', match: { predicted_probs: '{}', bookmaker_odds: '{}' } }).allowed, false);
});

t('check(): allows validated market only when the pick itself shows the gap', () => {
    const db = fakeDb(makeRows(4000, () => 0.62));
    const good = { market: 'Over 2.5 Goals', match: { predicted_probs: JSON.stringify({ over25Prob: 61 }), bookmaker_odds: JSON.stringify({ over25: 1.9, under25: 1.9 }) } };
    const weak = { market: 'Over 2.5 Goals', match: { predicted_probs: JSON.stringify({ over25Prob: 52 }), bookmaker_odds: JSON.stringify({ over25: 1.9, under25: 1.9 }) } };
    assert.strictEqual(gate.check(db, 'high_value', good).allowed, true);
    assert.strictEqual(gate.check(db, 'high_value', weak).allowed, false);
});

console.log(`\n${passed} tests passed`);

// Optional parity check against the real history
try {
    const Database = require('better-sqlite3');
    const { resolveDatabasePath } = require('./utils/path_resolver');
    const p = resolveDatabasePath(null, 'sportybet_archive.db');
    const db = new Database(p, { readonly: true });
    const ev = gate.getEvidence(db, { force: true });
    console.log(`\nReal-history check (${p}): any validated market? ${gate.anyMarketValidated(ev)}`);
    db.close();
} catch (e) {
    console.log('\n(real-database check skipped: ' + e.message.split('\n')[0] + ')');
}
