const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const srcPath = path.join(__dirname, 'databases/sportybet_archive.db');
const dstPath = path.join(__dirname, 'databases/sportybet_fresh.db');

if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);

console.log('Opening source DB...');
const src = new Database(srcPath);

// Get all table names and schema
const tables = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables found:', tables.map(t => t.name).join(', '));

const dst = new Database(dstPath);
dst.exec('PRAGMA journal_mode=WAL');

// Copy table schemas
for (const t of tables) {
  if (t.sql) {
    try {
      dst.exec(t.sql);
      console.log('Created table:', t.name);
    } catch(e) {
      console.warn('Table create warning:', t.name, e.message);
    }
  }
}

// Copy data from each table
for (const t of tables) {
  console.log('Copying table:', t.name, '...');
  try {
    const cols = src.prepare('PRAGMA table_info(' + t.name + ')').all().map(c => c.name);
    const rows = src.prepare('SELECT * FROM ' + t.name).all();
    console.log(' -> rows:', rows.length);

    if (rows.length > 0) {
      const placeholders = cols.map(() => '?').join(',');
      const insertStmt = dst.prepare(
        'INSERT OR IGNORE INTO ' + t.name + ' (' + cols.join(',') + ') VALUES (' + placeholders + ')'
      );
      const insertMany = dst.transaction((rows) => {
        for (const row of rows) {
          try {
            insertStmt.run(cols.map(c => row[c]));
          } catch(e) {
            // Skip corrupt rows silently
          }
        }
      });
      insertMany(rows);
      console.log(' -> copied OK');
    }
  } catch(e) {
    console.error(' -> ERROR copying', t.name, ':', e.message.slice(0, 120));
  }
}

// Recreate indexes
const indexes = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
for (const idx of indexes) {
  try {
    dst.exec(idx.sql);
    console.log('Created index:', idx.name);
  } catch(e) {
    console.warn('Index warning:', idx.name, e.message.slice(0, 80));
  }
}

// Final check
const check = dst.prepare('PRAGMA integrity_check').all();
console.log('\nRepaired DB integrity:', check.slice(0, 3).map(r => r.integrity_check).join('; '));

const lpCount = dst.prepare('SELECT COUNT(*) as cnt FROM live_predictions').get();
const aiCount = dst.prepare('SELECT COUNT(*) as cnt FROM ai_best_picks_history').get();
const fixtureCount = dst.prepare('SELECT COUNT(*) as cnt FROM sporty_fixtures').get();
console.log('live_predictions:', lpCount.cnt);
console.log('ai_best_picks_history:', aiCount.cnt);
console.log('sporty_fixtures:', fixtureCount.cnt);

src.close();
dst.close();
console.log('Done!');
