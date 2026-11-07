const Database = require('better-sqlite3');
const dbPath = 'E:\\\\Virtual FootBall Data\\\\virtual_football_archive.db';
const db = new Database(dbPath);
const rows = db.prepare("SELECT id, data FROM seasons").all();

for (const row of rows) {
  console.log(`\n=== Season ID ${row.id} ===`);
  const parsed = JSON.parse(row.data);
  const seenTables = new Set();
  
  function simulateRender(obj, path = "") {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${k}` : k;
        if (k === 'tables' && Array.isArray(v)) {
          const tableKey = JSON.stringify(v);
          const alreadySeen = seenTables.has(tableKey);
          console.log(`Table at ${currentPath}: length=${v.length}, alreadySeen=${alreadySeen}`);
          seenTables.add(tableKey);
        } else if (typeof v === 'object' && v !== null) {
          simulateRender(v, currentPath);
        }
      }
    }
  }
  simulateRender(parsed);
}
db.close();
