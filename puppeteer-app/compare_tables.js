const Database = require('better-sqlite3');
const dbPath = 'E:\\\\Virtual FootBall Data\\\\virtual_football_archive.db';
const db = new Database(dbPath);
const row = db.prepare("SELECT data FROM seasons LIMIT 1").get();
const parsed = JSON.parse(row.data);

const t1 = parsed.Overview?.default?.tables;
const t2 = parsed.Tables?.default?.tables;
const t3 = parsed.Tables?.['dropdown_Overview Overview']?.tables;

console.log("t1 length:", t1?.length);
console.log("t2 length:", t2?.length);
console.log("t3 length:", t3?.length);

console.log("t1 === t2 stringified:", JSON.stringify(t1) === JSON.stringify(t2));
console.log("t1 === t3 stringified:", JSON.stringify(t1) === JSON.stringify(t3));

db.close();
