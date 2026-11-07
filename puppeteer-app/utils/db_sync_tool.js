'use strict';

/**
 * utils/db_sync_tool.js
 *
 * Incremental, conflict-safe SQLite synchronisation between two copies of the same database
 * (e.g. this PC and the VPS). Never overwrites a database file - rows are MERGED:
 *   - new rows are inserted using each table's natural UNIQUE key (INSERT OR IGNORE),
 *   - existing rows only get their empty fields filled in (e.g. actual_score arrives later),
 *     'pending' statuses are upgraded to won/lost, scored_status takes the max.
 * Safe to run while the scraper/dashboard is writing (WAL + busy timeout + short transactions).
 *
 * Commands:
 *   node utils/db_sync_tool.js export <db> <out.gz> --peer <name> [--lookback-hours 6]
 *       Packs rows the peer has not received yet (rowid > last acked) plus any row with a kickoff
 *       in the last N hours (to carry late score updates). Writes <db>.sync-<peer>.pending.json.
 *   node utils/db_sync_tool.js ack <db> --peer <name>
 *       Call after the peer merged successfully: promotes the pending watermark.
 *   node utils/db_sync_tool.js merge <package.gz> <db>
 *       Merges a package into <db> (creates <db> / missing tables if needed).
 *   node utils/db_sync_tool.js info <db>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');

const TIME_COLS = ['kickoff_timestamp', 'kickoff_ts'];
const SCHEMA_TABLE = '_sync_schema';
const skipTable = (n) => n.startsWith('sqlite_') || n === SCHEMA_TABLE || /_backup/i.test(n);
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const statePath = (db, peer) => `${db}.sync-${peer}.json`;
const pendingPath = (db, peer) => `${db}.sync-${peer}.pending.json`;

function argOf(args, name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }

async function gzipFile(src, dst) { await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dst)); }
async function gunzipFile(src, dst) { await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dst)); }
const rmQuiet = (p) => { for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(p + s); } catch (_) {} } };

// ------------------------------------------------------------------ export
async function cmdExport(dbPath, outPath, peer, lookbackHours) {
    if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
    const tmp = path.join(os.tmpdir(), `vfl_sync_export_${process.pid}_${Date.now()}.db`);
    rmQuiet(tmp);
    const out = new Database(tmp);
    out.pragma('journal_mode = OFF');
    out.pragma('synchronous = OFF');
    out.pragma('busy_timeout = 30000');
    out.prepare('ATTACH DATABASE ? AS src').run(path.resolve(dbPath));

    const state = readJson(statePath(dbPath, peer), { tables: {} });
    const cutoff = Date.now() - lookbackHours * 3600 * 1000;
    const pending = { peer, exportedAt: new Date().toISOString(), tables: {} };
    const summary = [];

    out.exec(`CREATE TABLE main.${SCHEMA_TABLE} (name TEXT PRIMARY KEY, sql TEXT)`);
    out.exec('BEGIN'); // one read transaction => consistent snapshot of src
    const tables = out.prepare(`SELECT name, sql FROM src.sqlite_master WHERE type='table'`).all().filter((t) => !skipTable(t.name));
    for (const t of tables) {
        const cols = out.prepare(`PRAGMA src.table_info(${q(t.name)})`).all();
        const timeCol = (cols.find((c) => TIME_COLS.includes(c.name)) || {}).name;
        const maxRowid = out.prepare(`SELECT max(rowid) m FROM src.${q(t.name)}`).get().m || 0;
        let last = state.tables[t.name] || 0;
        if (maxRowid < last) last = 0; // database was rebuilt -> full resend
        let where = `rowid > ${Number(last)}`;
        if (timeCol && last > 0) where += ` OR ${q(timeCol)} >= ${Math.floor(cutoff)}`;
        out.exec(`CREATE TABLE main.${q(t.name)} AS SELECT * FROM src.${q(t.name)} WHERE ${where}`);
        out.prepare(`INSERT INTO main.${SCHEMA_TABLE}(name, sql) VALUES (?, ?)`).run(t.name, t.sql);
        const n = out.prepare(`SELECT count(*) n FROM main.${q(t.name)}`).get().n;
        pending.tables[t.name] = maxRowid;
        summary.push(`${t.name}:${n}`);
    }
    out.exec('COMMIT');
    out.exec('DETACH DATABASE src');
    out.close();

    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    await gzipFile(tmp, outPath);
    rmQuiet(tmp);
    fs.writeFileSync(pendingPath(dbPath, peer), JSON.stringify(pending, null, 2));
    const mb = (fs.statSync(outPath).size / 1048576).toFixed(2);
    console.log(`[export] ${dbPath} -> ${outPath} (${mb} MB) rows: ${summary.join(', ')}`);
}

// ------------------------------------------------------------------ ack
function cmdAck(dbPath, peer) {
    const p = pendingPath(dbPath, peer);
    if (!fs.existsSync(p)) { console.log('[ack] nothing pending'); return; }
    fs.renameSync(p, statePath(dbPath, peer));
    console.log(`[ack] watermark updated for peer "${peer}"`);
}

function cmdMarkSynced(dbPath, peer) {
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = {};
    for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) {
        if (skipTable(t.name)) continue;
        tables[t.name] = db.prepare(`SELECT max(rowid) m FROM ${q(t.name)}`).get().m || 0;
    }
    db.close();
    fs.writeFileSync(statePath(dbPath, peer), JSON.stringify({ peer, exportedAt: new Date().toISOString(), tables }, null, 2));
    try { fs.unlinkSync(pendingPath(dbPath, peer)); } catch (_) {}
    console.log(`[mark-synced] watermark aligned to current DB head for peer "${peer}"`);
}

// ------------------------------------------------------------------ merge
function uniqueKey(db, table) {
    const idx = db.prepare(`PRAGMA main.index_list(${q(table)})`).all().filter((i) => i.unique);
    const pick = idx.find((i) => i.origin === 'u') || idx.find((i) => i.origin === 'c');
    if (!pick) return null;
    return db.prepare(`PRAGMA main.index_info(${q(pick.name)})`).all().sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
}

async function cmdMerge(pkgPath, dbPath) {
    if (!fs.existsSync(pkgPath)) throw new Error(`package not found: ${pkgPath}`);
    let pkgDb = pkgPath, tmp = null;
    if (pkgPath.endsWith('.gz')) {
        tmp = path.join(os.tmpdir(), `vfl_sync_merge_${process.pid}_${Date.now()}.db`);
        await gunzipFile(pkgPath, tmp);
        pkgDb = tmp;
    }
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 60000');
    db.prepare('ATTACH DATABASE ? AS pkg').run(path.resolve(pkgDb));
    const schemas = new Map(db.prepare(`SELECT name, sql FROM pkg.${SCHEMA_TABLE}`).all().map((r) => [r.name, r.sql]));
    const report = [];
    try {
        for (const [table, sql] of schemas) {
            if (skipTable(table)) continue;
            const exists = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?`).get(table);
            if (!exists) { db.exec(sql); report.push(`${table}: created`); }
            const key = uniqueKey(db, table);
            if (!key || !key.length) { report.push(`${table}: skipped (no unique key)`); continue; }
            const mCols = db.prepare(`PRAGMA main.table_info(${q(table)})`).all();
            const pCols = new Set(db.prepare(`PRAGMA pkg.table_info(${q(table)})`).all().map((c) => c.name));
            const pk = mCols.filter((c) => c.pk > 0);
            const autoPk = pk.length === 1 && /INT/i.test(pk[0].type) ? pk[0].name : null;
            const common = mCols.map((c) => c.name).filter((n) => pCols.has(n) && n !== autoPk);
            if (!key.every((k) => common.includes(k))) { report.push(`${table}: skipped (key mismatch)`); continue; }

            const tx = db.transaction(() => {
                const colList = common.map(q).join(', ');
                const inserted = db.prepare(`INSERT OR IGNORE INTO main.${q(table)} (${colList}) SELECT ${colList} FROM pkg.${q(table)}`).run().changes;
                const upd = common.filter((c) => !key.includes(c));
                let updated = 0;
                if (upd.length) {
                    const sets = [], conds = [];
                    for (const c of upd) {
                        const m = `m.${q(c)}`, p = `p.${q(c)}`;
                        if (c === 'status' || c === 'pick_status') {
                            const cond = `((${m} IS NULL OR ${m} = 'pending') AND ${p} IS NOT NULL AND ${p} <> 'pending')`;
                            sets.push(`${q(c)} = CASE WHEN ${cond} THEN ${p} ELSE ${m} END`); conds.push(cond);
                        } else if (c === 'scored_status') {
                            sets.push(`${q(c)} = max(coalesce(${m}, 0), coalesce(${p}, 0))`); conds.push(`coalesce(${p}, 0) > coalesce(${m}, 0)`);
                        } else {
                            sets.push(`${q(c)} = coalesce(${m}, ${p})`); conds.push(`(${m} IS NULL AND ${p} IS NOT NULL)`);
                        }
                    }
                    const join = key.map((k) => `m.${q(k)} IS p.${q(k)}`).join(' AND ');
                    updated = db.prepare(`UPDATE main.${q(table)} AS m SET ${sets.join(', ')} FROM pkg.${q(table)} AS p WHERE ${join} AND (${conds.join(' OR ')})`).run().changes;
                }
                return { inserted, updated };
            });
            const r = tx();
            report.push(`${table}: +${r.inserted} new, ${r.updated} updated`);
        }
    } finally {
        db.exec('DETACH DATABASE pkg');
        db.close();
        if (tmp) rmQuiet(tmp);
    }
    console.log(`[merge] ${pkgPath} -> ${dbPath}\n   ` + report.join('\n   '));
}

// ------------------------------------------------------------------ info
function cmdInfo(dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) {
        if (skipTable(t.name)) continue;
        const n = db.prepare(`SELECT count(*) n, max(rowid) m FROM ${q(t.name)}`).get();
        console.log(`${t.name.padEnd(45)} rows=${String(n.n).padStart(8)} maxRowid=${n.m}`);
    }
    try { const m = db.prepare('SELECT max(kickoff_timestamp) m FROM live_predictions').get().m; console.log('newest live_predictions kickoff:', m ? new Date(m).toISOString() : '-'); } catch (_) {}
    db.close();
}

// ------------------------------------------------------------------ cli
(async () => {
    const [cmd, a1, a2, ...rest] = process.argv.slice(2);
    const args = process.argv.slice(2);
    try {
        if (cmd === 'export') await cmdExport(a1, a2, argOf(args, '--peer', 'peer'), parseFloat(argOf(args, '--lookback-hours', '6')));
        else if (cmd === 'ack') cmdAck(a1, argOf(args, '--peer', 'peer'));
        else if (cmd === 'mark-synced') cmdMarkSynced(a1, argOf(args, '--peer', 'peer'));
        else if (cmd === 'merge') await cmdMerge(a1, a2);
        else if (cmd === 'info') cmdInfo(a1);
        else { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(2); }
    } catch (e) {
        console.error(`[db_sync_tool] ${cmd} failed: ${e.message}`);
        process.exit(1);
    }
})();
