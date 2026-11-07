const Database = require('better-sqlite3');
const predictor = require('./utils/ai_best_predictor');
const { buildLiveFeatureVector } = require('./utils/ai_best_feature_builder');
const thresholds = require('./utils/ai_best_htft_thresholds.json');
const { resolveDatabasePath, resolvePythonExecutable } = require('./utils/path_resolver');
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });
const pythonBin = resolvePythonExecutable();

const HTFT_LABELS = ['htft11','htft1X','htft12','htftX1','htftXX','htftX2','htft21','htft2X','htft22'];
const PROFITABLE = ['htft11','htftXX','htft22'];

console.log('Thresholds in effect:');
PROFITABLE.forEach(k => {
    const t = thresholds[k];
    console.log(`  ${k}: min_prob=${(t.min_prob*100).toFixed(0)}%  oos_roi=+${t.oos_roi}%`);
});
console.log('');

// Get raw XGBoost probs by running inference through Python directly
const rows = db.prepare(`
    SELECT id, home_team, away_team, predicted_probs, bookmaker_odds
    FROM live_predictions
    WHERE bookmaker_odds IS NOT NULL AND predicted_probs LIKE '%htft11Prob%'
    ORDER BY id DESC LIMIT 20
`).all();

// Build feature vectors via the builder
const fvs = rows.map(row => {
    const rawProbs = JSON.parse(row.predicted_probs || '{}');
    const homeForm = predictor.loadTeamForm(db, row.home_team, true, 15);
    const awayForm = predictor.loadTeamForm(db, row.away_team, false, 15);
    return buildLiveFeatureVector(rawProbs, homeForm, awayForm);
});

// Run Python inference
const modelJsonPath = path.join(__dirname, 'utils', 'ai_best_htft_model.json').replace(/\\/g, '/');
const tmpIn  = path.join(os.tmpdir(), 'diag_fvs.json').replace(/\\/g, '/');
const tmpOut = path.join(os.tmpdir(), 'diag_proba.json').replace(/\\/g, '/');
const tmpPy  = path.join(os.tmpdir(), 'diag.py').replace(/\\/g, '/');

fs.writeFileSync(tmpIn, JSON.stringify(fvs));

const pyScript = `
import json, numpy as np
import xgboost as xgb
model = xgb.XGBClassifier()
model.load_model('${modelJsonPath}')
X = np.array(json.load(open('${tmpIn}')), dtype=np.float32)
proba = model.predict_proba(X).tolist()
with open('${tmpOut}', 'w') as f: json.dump(proba, f)
`;
fs.writeFileSync(tmpPy, pyScript);
require('child_process').execSync(`"${pythonBin}" "${tmpPy}"`);
const proba = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));

// Show per-match probabilities
let maxP11=0, maxPXX=0, maxP22=0, betsIfRelaxed=0;
const RELAXED_THRESH = 0.15; // 15% — still profitable per 500-row test

console.log('=== Per-match XGBoost probabilities ===');
rows.forEach((row, i) => {
    const pv = proba[i];
    const p11 = pv[0]*100, pXX = pv[4]*100, p22 = pv[8]*100;
    const htftOdds = (JSON.parse(row.bookmaker_odds||'{}')).htft || {};
    maxP11 = Math.max(maxP11, p11);
    maxPXX = Math.max(maxPXX, pXX);
    maxP22 = Math.max(maxP22, p22);
    
    const wouldBetRelaxed = p11 >= RELAXED_THRESH*100 || pXX >= RELAXED_THRESH*100 || p22 >= RELAXED_THRESH*100;
    if (wouldBetRelaxed) betsIfRelaxed++;
    
    const f11 = p11 >= thresholds.htft11.min_prob*100 ? '✅' : '  ';
    const fXX = pXX >= thresholds.htftXX.min_prob*100 ? '✅' : '  ';
    const f22 = p22 >= thresholds.htft22.min_prob*100 ? '✅' : '  ';
    console.log(`${row.home_team} vs ${row.away_team}`);
    console.log(`  ${f11} htft11: ${p11.toFixed(1)}%(need ${(thresholds.htft11.min_prob*100).toFixed(0)}%)  ${fXX} htftXX: ${pXX.toFixed(1)}%(need ${(thresholds.htftXX.min_prob*100).toFixed(0)}%)  ${f22} htft22: ${p22.toFixed(1)}%(need ${(thresholds.htft22.min_prob*100).toFixed(0)}%)`);
});

console.log(`\n=== Summary ===`);
console.log(`Max probs in these 20 matches: htft11=${maxP11.toFixed(1)}%  htftXX=${maxPXX.toFixed(1)}%  htft22=${maxP22.toFixed(1)}%`);
console.log(`With strict thresholds (33/35/43%): 0/20 bets`);
console.log(`With relaxed thresholds (15%):      ${betsIfRelaxed}/20 bets`);

// Now scan ALL live predictions for bet hit rate
const allRows = db.prepare(`
    SELECT predicted_probs, bookmaker_odds, home_team, away_team
    FROM live_predictions
    WHERE bookmaker_odds IS NOT NULL AND predicted_probs LIKE '%htft11Prob%'
`).all();

let strictBets=0, relaxedBets=0;
const allFvs = allRows.map(row => {
    const rawProbs = JSON.parse(row.predicted_probs || '{}');
    const homeForm = predictor.loadTeamForm(db, row.home_team, true, 15);
    const awayForm = predictor.loadTeamForm(db, row.away_team, false, 15);
    return buildLiveFeatureVector(rawProbs, homeForm, awayForm);
});
fs.writeFileSync(tmpIn, JSON.stringify(allFvs));
require('child_process').execSync(`"${pythonBin}" "${tmpPy}"`);
const allProba = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));

allProba.forEach(pv => {
    const p11=pv[0], pXX=pv[4], p22=pv[8];
    if (p11>=thresholds.htft11.min_prob || pXX>=thresholds.htftXX.min_prob || p22>=thresholds.htft22.min_prob) strictBets++;
    if (p11>=0.15 || pXX>=0.15 || p22>=0.15) relaxedBets++;
});

const nRounds = allRows.length / 20;
console.log(`\nAcross ALL ${allRows.length} predictions (≈${nRounds.toFixed(0)} rounds):`);
console.log(`  Strict (33/35/43%): ${strictBets} bets = ${(strictBets/nRounds).toFixed(2)} per round`);
console.log(`  Relaxed (15%):      ${relaxedBets} bets = ${(relaxedBets/nRounds).toFixed(2)} per round`);

db.close();
