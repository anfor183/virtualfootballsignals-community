const Database = require('better-sqlite3');
const { resolveDatabasePath } = require('./utils/path_resolver');
const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });
const predictor = require('./utils/ai_best_predictor');

console.log('Model ready:', predictor.isModelReady());
console.log('Status:', predictor.getModelStatus().message);
console.log('');

const testRows = db.prepare(`
    SELECT id, home_team, away_team, predicted_probs, bookmaker_odds
    FROM live_predictions
    WHERE bookmaker_odds IS NOT NULL
      AND predicted_probs LIKE '%htft11Prob%'
    ORDER BY id DESC LIMIT 20
`).all();

console.log('Testing on last', testRows.length, 'predictions:');
console.log('='.repeat(70));
let bets = 0;
testRows.forEach(row => {
    const rawProbs = JSON.parse(row.predicted_probs || '{}');
    const bookOdds = JSON.parse(row.bookmaker_odds || '{}');
    const homeForm = predictor.loadTeamForm(db, row.home_team, true, 15);
    const awayForm = predictor.loadTeamForm(db, row.away_team, false, 15);
    const bet = predictor.predictAndRecommendSync(rawProbs, homeForm, awayForm, bookOdds);
    if (bet) {
        bets++;
        console.log(`✅ BET: ${row.home_team} vs ${row.away_team}`);
        console.log(`   ${bet.market} @ ${bet.bookOdd} | EV: +${bet.ev}% | Prob: ${bet.calibratedProb}% | Kelly: ${(bet.kellyFraction*100).toFixed(1)}% | ${bet.source}`);
    } else {
        console.log(`⏭  SKIP: ${row.home_team} vs ${row.away_team}`);
    }
});
console.log('='.repeat(70));
console.log(`Bets: ${bets}/${testRows.length} (${(bets/testRows.length*100).toFixed(0)}%)`);
db.close();
