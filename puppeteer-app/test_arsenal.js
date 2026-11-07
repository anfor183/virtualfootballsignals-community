const Database = require('better-sqlite3');
const { resolveDatabasePath } = require('./utils/path_resolver');
const dbPath = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');
const db = new Database(dbPath, { readonly: true });
const predictor = require('./utils/ai_best_predictor');

// Find Arsenal vs Fulham
const row = db.prepare(`
    SELECT id, home_team, away_team, predicted_probs, bookmaker_odds
    FROM live_predictions
    WHERE home_team='Arsenal' AND away_team='Fulham'
    ORDER BY id DESC LIMIT 1
`).get();

if (!row) { console.log('Row not found'); process.exit(1); }

console.log('Match:', row.home_team, 'vs', row.away_team);
const rawProbs = JSON.parse(row.predicted_probs || '{}');
const bookOdds = JSON.parse(row.bookmaker_odds || '{}');

console.log('htft11Prob from rawProbs:', rawProbs.htft11Prob);
console.log('Book htft odds:', JSON.stringify(bookOdds.htft || bookOdds.halftimeFulltime || 'MISSING'));

const homeForm = predictor.loadTeamForm(db, row.home_team, true, 15);
const awayForm = predictor.loadTeamForm(db, row.away_team, false, 15);

console.log('Home form rows:', homeForm.length);
console.log('Away form rows:', awayForm.length);

// Step through each gate manually
const thresholds = require('./utils/ai_best_htft_thresholds.json');
const PROFITABLE_MARKETS = new Set(['htft11Prob', 'htftXXProb', 'htft22Prob']);

const bet = predictor.predictAndRecommendSync(rawProbs, homeForm, awayForm, bookOdds);
console.log('\nFinal bet result:', bet);

// Check what XGBoost outputs for this match
const { buildLiveFeatureVector } = require('./utils/ai_best_feature_builder');
const fv = buildLiveFeatureVector(rawProbs, homeForm, awayForm);
const { spawnSync } = require('child_process');
const UTILS = __dirname + '/utils';
const MODEL = UTILS + '/ai_best_htft_model.json';
const script = `
import json, sys, numpy as np
import xgboost as xgb
model = xgb.XGBClassifier()
model.load_model('${MODEL}')
X = np.array(json.loads(sys.stdin.read()), dtype=np.float32)
proba = model.predict_proba(X)
print(json.dumps(proba.tolist()))
`;
const res = spawnSync('python3', ['-c', script], { input: JSON.stringify([fv]), encoding: 'utf8', timeout: 10000 });
const proba = JSON.parse(res.stdout.trim())[0];
const LABELS = ['htft11','htft1X','htft12','htftX1','htftXX','htftX2','htft21','htft2X','htft22'];
console.log('\nXGBoost raw proba:');
LABELS.forEach((l,i) => console.log(`  ${l}: ${(proba[i]*100).toFixed(1)}%`));

console.log('\nGate checks for htft11Prob:');
const calibP = proba[0]; // already 0-1
console.log('  calibP (0-1):', calibP.toFixed(4));
console.log('  MIN_PROB:', 0.10);
console.log('  min_prob gate (', thresholds.htft11.min_prob, '):', thresholds.htft11.min_prob, '>', calibP, '=', thresholds.htft11.min_prob > calibP);

// Note: probaVecToProbs multiplies by 100, then predictAndRecommendSync divides by 100
// So calibP in the loop = proba[i]*100 / 100 = proba[i] — correct

const htft = bookOdds.htft || {};
const odd11 = htft.htft11;
const ev11 = calibP * odd11 - 1.0;
console.log('  book odd htft11:', odd11);
console.log('  EV:', ev11.toFixed(4), '(need > 0)');

db.close();
