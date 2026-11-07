const Database = require('better-sqlite3');
const { resolveDatabasePath } = require('./utils/path_resolver');
const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });
const picks = db.prepare(`
  SELECT 
    id, match_time, predicted_probs, actual_score, kickoff_timestamp 
  FROM historical_market_predictions 
  WHERE actual_score IS NOT NULL 
    AND predicted_probs IS NOT NULL
`).all();

let total = 0;
let won = 0;
let homeWins = 0;
let awayWins = 0;
let draws = 0;
let homePreds = 0;
let awayPreds = 0;
let drawPreds = 0;

const timeStats = {};
const probStats = {
  high: { total: 0, won: 0 }, // > 70%
  med: { total: 0, won: 0 }, // 55% - 70%
  low: { total: 0, won: 0 } // < 55%
};

picks.forEach(p => {
  if (!p.actual_score || p.actual_score === 'null') return;
  const parts = p.actual_score.split(':');
  if(parts.length !== 2) return;
  
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if(isNaN(h) || isNaN(a)) return;

  const actualOutcome = h > a ? 'Home' : a > h ? 'Away' : 'Draw';
  
  if(actualOutcome === 'Home') homeWins++;
  if(actualOutcome === 'Away') awayWins++;
  if(actualOutcome === 'Draw') draws++;

  // Derive predicted result from predicted_probs
  let hw = 0, dr = 0, aw = 0;
  try {
    const probs = JSON.parse(p.predicted_probs);
    hw = probs.homeWinProb || 0;
    dr = probs.drawProb || 0;
    aw = probs.awayWinProb || 0;
  } catch(e) { return; }
  
  const conf = Math.max(hw, dr, aw);
  if (conf === 0) return;

  const predictedOutcome = hw >= dr && hw >= aw ? 'Home' : (aw >= hw && aw >= dr ? 'Away' : 'Draw');
  const isWin = predictedOutcome === actualOutcome;

  if(predictedOutcome === 'Home') homePreds++;
  if(predictedOutcome === 'Away') awayPreds++;
  if(predictedOutcome === 'Draw') drawPreds++;

  total++;
  if (isWin) won++;

  // Probability analysis
  if(conf >= 70) {
    probStats.high.total++;
    if(isWin) probStats.high.won++;
  } else if(conf >= 55) {
    probStats.med.total++;
    if(isWin) probStats.med.won++;
  } else {
    probStats.low.total++;
    if(isWin) probStats.low.won++;
  }

  // Time analysis
  if (p.kickoff_timestamp) {
    const d = new Date(Number(p.kickoff_timestamp));
    const hour = d.getHours();
    if (!isNaN(hour)) {
      if (!timeStats[hour]) timeStats[hour] = { total: 0, won: 0, byOutcome: { Home: { total: 0, won: 0 }, Away: { total: 0, won: 0 }, Draw: { total: 0, won: 0 } } };
      timeStats[hour].total++;
      if (isWin) timeStats[hour].won++;
      
      timeStats[hour].byOutcome[predictedOutcome].total++;
      if(isWin) timeStats[hour].byOutcome[predictedOutcome].won++;
    }
  }
});

console.log('--- SPORTYBET ML PREDICTIONS BACKTEST (Historical) ---');
console.log('Total ML Picks Analyzed:', total);
console.log('Won:', won);
console.log('Overall Win Rate:', ((won / total) * 100).toFixed(2) + '%');

console.log('\n--- Actual Outcome Distribution ---');
console.log(`Home Wins: ${homeWins} (${((homeWins/total)*100).toFixed(2)}%)`);
console.log(`Draws: ${draws} (${((draws/total)*100).toFixed(2)}%)`);
console.log(`Away Wins: ${awayWins} (${((awayWins/total)*100).toFixed(2)}%)`);

console.log('\n--- Model Prediction Distribution ---');
console.log(`Home Preds: ${homePreds} (${((homePreds/total)*100).toFixed(2)}%)`);
console.log(`Draw Preds: ${drawPreds} (${((drawPreds/total)*100).toFixed(2)}%)`);
console.log(`Away Preds: ${awayPreds} (${((awayPreds/total)*100).toFixed(2)}%)`);

console.log('\n--- Confidence Tier Analysis ---');
const printTier = (tier, name) => {
  if(tier.total > 0) {
    console.log(`${name}: ${tier.won}/${tier.total} (${((tier.won/tier.total)*100).toFixed(2)}%)`);
  } else {
    console.log(`${name}: 0/0 (0%)`);
  }
};
printTier(probStats.high, 'High Conf (>70%)');
printTier(probStats.med, 'Med Conf (55-70%)');
printTier(probStats.low, 'Low Conf (<55%)');

console.log('\n--- Time Analysis (By Hour) ---');
Object.keys(timeStats).sort((a,b) => Number(a) - Number(b)).forEach(h => {
  const s = timeStats[h];
  const rate = ((s.won / s.total) * 100).toFixed(2);
  console.log(`Hour ${String(h).padStart(2, '0')}: ${s.won}/${s.total} (${rate}%) | Home: ${s.byOutcome.Home.won}/${s.byOutcome.Home.total} | Away: ${s.byOutcome.Away.won}/${s.byOutcome.Away.total}`);
});

db.close();
