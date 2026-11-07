const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { resolveDatabasePath } = require('./utils/path_resolver');

const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
console.log(`Connecting to database: ${dbPath}`);
try {
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT id, league_name, season_name, data FROM seasons").all();
    for (const row of rows) {
        if (!row.data) continue;
        const parsed = JSON.parse(row.data);
        console.log(`Season ID ${row.id} (${row.season_name}):`);
        
        // Count non-empty arrays in parsed data recursively
        function traverseAndCount(obj, path = "") {
            if (!obj) return;
            if (Array.isArray(obj)) {
                if (obj.length > 0) {
                    console.log(`  Found non-empty array at ${path} with length ${obj.length}`);
                }
                return;
            }
            if (typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    traverseAndCount(v, path ? `${path}.${k}` : k);
                }
            }
        }
        traverseAndCount(parsed);
    }
    db.close();
} catch (e) {
    console.error("Error:", e);
}
