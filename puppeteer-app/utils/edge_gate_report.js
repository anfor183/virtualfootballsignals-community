'use strict';

/**
 * utils/edge_gate_report.js — prints which markets currently pass the evidence gate.
 * Usage: node utils/edge_gate_report.js [path/to/sportybet_archive.db]
 */

const Database = require('better-sqlite3');
const { resolveDatabasePath } = require('./path_resolver');
const gate = require('./edge_gate');

const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });
const cfg = gate.getSettings();
const ev = gate.getEvidence(db, { force: true });

console.log(`Database : ${dbPath}`);
console.log(`Gate     : ${cfg.strictEdgeGate ? 'ENABLED' : 'DISABLED (legacy always-pick mode)'}`);
console.log(`Evidence : last ${ev._meta.rows} settled matches | min gap ${(cfg.edgeGateMinGap * 100).toFixed(1)}pp | min sample ${cfg.edgeGateMinSample} | z ${cfg.edgeGateZ}`);
console.log('');
console.log('Market'.padEnd(34) + 'n'.padStart(7) + 'ROI%'.padStart(8) + 'LCB%'.padStart(8) + 'old%'.padStart(8) + 'new%'.padStart(8) + '  verdict');

const rows = Object.values(ev).filter(v => v && v.market);
rows.sort((a, b) => (b.lcbPct ?? -999) - (a.lcbPct ?? -999));
for (const r of rows) {
    const f = (x) => (x === null || x === undefined ? '-' : x.toFixed(1));
    console.log(
        r.market.padEnd(34) + String(r.n).padStart(7) + f(r.roiPct).padStart(8) + f(r.lcbPct).padStart(8) +
        f(r.roiOldPct).padStart(8) + f(r.roiNewPct).padStart(8) + '  ' + (r.validated ? 'VALIDATED' : 'blocked: ' + r.reason)
    );
}
console.log('');
console.log(gate.anyMarketValidated(ev)
    ? 'At least one market is validated: picks in those markets may be published.'
    : 'No market has a demonstrated, stable edge: the system will publish NO picks (this avoids paying the bookmaker margin).');
db.close();
