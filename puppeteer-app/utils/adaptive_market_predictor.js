'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const features = require('./ai_best_market_features');
const { pickDecision } = require('./pick_policy');
const ENGINES = new Set(['safest', 'ai_best', 'high_chance']);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function loadBundle(engine, directory = __dirname) {
    if (!ENGINES.has(engine)) return null;
    const manifest = readJson(path.join(directory, `${engine}_market_active.json`));
    if (!manifest) return null;
    const model = path.resolve(directory, manifest.model || ''), reportPath = path.resolve(directory, manifest.report || '');
    const prefix = path.resolve(directory, 'adaptive_models') + path.sep;
    if (!model.startsWith(prefix) || !reportPath.startsWith(prefix) || !fs.existsSync(model)) return null;
    const report = readJson(reportPath);
    if (report?.schema_version !== features.enginePolicy(engine,{},!!report?.engine_policy?.contextFeatures).schemaVersion || report.version !== manifest.version) return null;
    return { manifest, report, model };
}
function getModelStatus(engine = 'ai_best',stakingMode='martingale_2_0') {
    const bundle = loadBundle(engine), monitoring = readJson(path.join(__dirname, `${engine}_market_monitor.json`));
    if (!bundle) return { ready: false, status: 'not_trained', message: 'Independent adaptive model is not trained yet' };
    const r = bundle.report;
    const ai = readJson(path.join(__dirname, '../browser-config.json'))?.ai || {};
    const policy = features.enginePolicy(engine, ai, !!r.engine_policy?.contextFeatures);
    const blocked = policy.blockedMarkets;
    const changed = JSON.stringify(blocked) !== JSON.stringify(r.blocked_markets || []) ||
        engine === 'ai_best' && (Number(ai.highRiskMinOdds) || 3.3) !== r.min_odds ||
        engine === 'high_chance' && JSON.stringify(policy) !== JSON.stringify(r.engine_policy);
    const paused = monitoring?.model_version === r.version && monitoring?.paused;
    const strategy = require('./strategy_release').releaseStatus(engine,r.version,__dirname,stakingMode);
    return {
        ready: !paused, // Shadow mode removed: live predictions active
        status: changed ? 'settings_changed' : paused ? 'paused_drift' : 'xgboost',
        message: changed ? 'Selection settings changed' : paused ? monitoring.reason : 'Independent model active for live predictions',
        trainedOn: r.trained_on, avgOosRoi: r.avg_oos_roi, profitableFolds: r.profitable_folds,
        version: r.version, audit: r.audit, monitoring, qualifiedStakingModes: strategy.qualifiedModes,
        signalStakingMode: strategy.mode
    };
}
function choose(candidates, probabilities, report, { shadow = false, paused = false, validation = false } = {}) {
    if (paused) return null;
    const eligible = candidates.map((c, i) => ({ ...c, probability: probabilities[i] }))
        .filter(c => {
            if (!Number.isFinite(c.probability) || c.probability <= 0 || c.probability >= 1) return false;
            if (shadow || report.engine.startsWith('safest')) return true;
            const threshold = report.thresholds?.[String(c.marketIndex)];
            return !threshold || (c.probability >= (threshold.min_prob || 0.4) && (c.probability * c.price - 1) >= (threshold.min_ev || 0));
        });
    eligible.sort((a,b) => b.probability-a.probability || b.probability*b.price-a.probability*a.price);
    return eligible[0] || null;
}
function scoreMatches(db, matches, { engine = 'ai_best', shadow = false, includePolicy = false } = {}) {
    const bundle = loadBundle(engine);
    if (!bundle) return [];
    const settings = readJson(path.join(__dirname, '../browser-config.json'))?.ai || {};
    const policy = features.enginePolicy(engine, settings, !!bundle.report.engine_policy?.contextFeatures);
    const minimum = Math.max(bundle.report.min_odds, policy.minOdds);
    const history = features.loadHistory(db, Date.now(), policy.contextFeatures);
    const context = policy.contextFeatures ? require('./match_context_features').MatchContext.fromHistory(history) : null;
    const pool = matches.filter(m => m.scored_status === 0 && !m.actual_score && Number(m.kickoff_timestamp) > Date.now())
        .filter(m => shadow || pickDecision(engine, m).allowed)
        .filter(m => bundle.report.scopes.includes(features.scope(m)))
        .flatMap(m => features.candidates(m, history, minimum, policy, context));
    if (!pool.length) return [];
    const python = fs.existsSync(path.join(__dirname, 'venv/bin/python3')) ? path.join(__dirname, 'venv/bin/python3') : process.platform === 'win32' ? 'python' : 'python3';
    const script = `import json,sys,numpy as np,xgboost as xgb
m=xgb.Booster(params={'nthread':2});m.load_model(sys.argv[1])
x=np.asarray(json.load(sys.stdin),dtype=np.float32)
print(json.dumps(m.predict(xgb.DMatrix(x),iteration_range=(0,int(sys.argv[2])+1)).tolist()))`;
    const result = spawnSync(python, ['-c', script, bundle.model, String(bundle.manifest.best_iteration)],
        { input: JSON.stringify(pool.map(c => c.features)), encoding: 'utf8', timeout: 20000,
            env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' }, maxBuffer: 8*1024*1024 });
    if (result.status !== 0 || result.error) throw new Error('Independent model inference failed: ' + (result.stderr || result.error));
    const raw = JSON.parse(result.stdout), calibration = bundle.report.calibration;
    if (!Array.isArray(raw) || raw.length !== pool.length) throw new Error('Invalid model probability response');
    const probabilities = raw.map((p,i) => {
        if (!Number.isFinite(p) || p < 0 || p > 1) return NaN;
        const v = Math.max(1e-6, Math.min(1-1e-6,p));
        const calibrated = 1/(1+Math.exp(-Math.max(-30,Math.min(30,calibration.slope*Math.log(v/(1-v))+calibration.intercept))));
        return calibrated*calibration.model_weight + pool[i].fair*(1-calibration.model_weight);
    });
    const rounds = new Map(), activeStatus = getModelStatus(engine);
    const paused = !activeStatus.ready || activeStatus.version !== bundle.report.version;
    pool.forEach((c,i) => {
        const key = `${c.match.season_name}|${c.match.round_number}`;
        if (!rounds.has(key)) rounds.set(key, []);
        rounds.get(key).push({ c, p: probabilities[i] });
    });
    return [...rounds.values()].flatMap(group => {
        const winner = choose(group.map(g=>g.c), group.map(g=>g.p), bundle.report, { shadow: true, paused: false });
        if (!winner) return [];
        const prob = winner.probability * 100, ev = (winner.probability*winner.price-1)*100;
        return [{
            match: winner.match, market: winner.market, prob, calibratedProb: prob, calibratedProbPct: prob,
            calibratedProbDecimal: winner.probability, impliedOdd: winner.price, bookOdd: winner.price,
            odds: winner.price, evPct: ev, ev, bookmakerImpliedProb: winner.fair*100,
            displayedConfidence: prob, recommendationScore: prob, source: `${engine}_adaptive_xgboost`,
            modelVersion: bundle.report.version, publishEligible: true, observationLane: 'live',
            engineMeta: { engine, source: `${engine}_adaptive_xgboost`, calibratedProbPct: prob,
                evPct: ev, displayedConfidence: prob, modelVersion: bundle.report.version }
        }];
    }).filter(Boolean);
}
function scoreRound(db, matches, options = {}) {
    return scoreMatches(db, matches, options).sort((a,b) => b.prob-a.prob || b.evPct-a.evPct)[0] || null;
}
module.exports = { loadBundle, getModelStatus, choose, scoreMatches, scoreRound };
