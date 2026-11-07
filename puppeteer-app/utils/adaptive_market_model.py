#!/usr/bin/env python3
"""Independent Safest/AI Best models with chronological calibration and audit.

Training uses actual fixture prices and results. Tuning never sees the final
audit block. A versioned artifact bundle is activated with one atomic pointer.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import uuid

import numpy as np
import xgboost as xgb
from sklearn.linear_model import LogisticRegression


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(np.mean(-y * np.log(p) - (1 - y) * np.log(1 - p)))


def calibrated(p, calibration, fair):
    logits = np.log(np.clip(p, 1e-6, 1 - 1e-6) / np.clip(1 - p, 1e-6, 1))
    q = 1 / (1 + np.exp(-np.clip(calibration['slope'] * logits + calibration['intercept'], -30, 30)))
    return q * calibration['model_weight'] + fair * (1 - calibration['model_weight'])


def metrics(indices, y, prices, probabilities):
    i = np.asarray(indices, dtype=int)
    if not len(i):
        return dict(n=0, win_rate=None, roi=None, roi_lower_bound=None, win_lower_bound=None)
    hits = y[i]; pnl = hits * prices[i] - 1
    n = len(i); win = float(np.mean(hits)); z = 1.644854
    low = (win + z*z/(2*n) - z*np.sqrt(win*(1-win)/n + z*z/(4*n*n))) / (1 + z*z/n)
    return dict(n=n, win_rate=round(win * 100, 2), roi=round(float(np.mean(pnl))*100, 2),
                roi_lower_bound=round(float(np.mean(pnl)-z*np.std(pnl, ddof=1)/np.sqrt(n))*100, 2) if n > 1 else None,
                win_lower_bound=round(float(low)*100, 2),
                calibration_error=round(float(abs(np.mean(probabilities[i])-win)), 4), logloss=round(logloss(hits, probabilities[i]), 5))


def select_rounds(indices, p, prices, markets, rounds, policy=None):
    """Exactly the production objective: probability first, EV only breaks ties."""
    selected = {}
    for i in indices:
        if policy is not None:
            rule = policy.get(str(int(markets[i])))
            if not rule or p[i] < rule['min_prob'] or p[i]*prices[i]-1 < rule['min_ev']:
                continue
        key = rounds[i]
        if key not in selected or (p[i], p[i]*prices[i]) > (p[selected[key]], p[selected[key]]*prices[selected[key]]):
            selected[key] = int(i)
    return list(selected.values())


def fit_policy(indices, y, prices, p, markets, rounds, min_probability=.25):
    policy = {}
    # Threshold search belongs only to the tuning block. The audit block vetoes
    # deployment but is never used to search for a better threshold.
    for market in sorted(set(markets[indices])):
        best = None
        for floor in np.arange(min_probability, .91 if min_probability >= .75 else .81, .05):
            rule = {str(int(market)): dict(min_prob=round(float(floor), 2), min_ev=.03)}
            chosen = select_rounds(indices, p, prices, markets, rounds, rule)
            stat = metrics(chosen, y, prices, p)
            if stat['n'] < 40 or stat['roi_lower_bound'] <= 0:
                continue
            halves = np.array_split(np.array(chosen, dtype=int), 2)
            if any(metrics(h, y, prices, p)['roi'] <= 0 for h in halves):
                continue
            if best is None or stat['win_lower_bound'] > best[0]:
                best = (stat['win_lower_bound'], rule[str(int(market))])
        if best:
            policy[str(int(market))] = best[1]
    return policy


def chronological_blocks(kickoffs, fractions=(.65, .78, .89), cutoffs=None):
    times = np.unique(kickoffs)
    if len(times) < 200:
        raise ValueError('Need at least 200 distinct completed kickoff times')
    a, b, c = cutoffs if cutoffs is not None else [times[int(len(times)*f)] for f in fractions]
    return [np.flatnonzero(kickoffs < a), np.flatnonzero((kickoffs >= a) & (kickoffs < b)),
            np.flatnonzero((kickoffs >= b) & (kickoffs < c)), np.flatnonzero(kickoffs >= c)]


def load_dataset(db_path, source_dir, max_matches, min_odds, engine=None, context=False):
    keys = json.loads(subprocess.check_output(['node', '-e',
        'process.stdout.write(JSON.stringify(require(process.argv[1]).INPUT_PROB_KEYS))', str(source_dir/'ai_best_market_features.js')], text=True))
    conn = sqlite3.connect(Path(db_path).resolve().as_uri()+'?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    rows = []
    for r in conn.execute("""SELECT id, season_name, round_number, home_team, away_team,
        kickoff_timestamp, predicted_probs, bookmaker_odds, actual_score, actual_ht_score
        FROM live_predictions WHERE scored_status=1 AND scored_with_prediction=1
        AND actual_score IS NOT NULL AND predicted_probs IS NOT NULL AND bookmaker_odds IS NOT NULL
        AND kickoff_timestamp > 0 ORDER BY kickoff_timestamp DESC, id DESC LIMIT ?""", (max_matches,)):
        try:
            record = dict(r); probs = json.loads(record['predicted_probs'])
            # Strip unrelated nested diagnostics before transfer; features consume
            # only these declared fields. Avoid Node's 512 MB single-string limit.
            record['predicted_probs'] = {k: probs[k] for k in keys if k in probs}
            record['bookmaker_odds'] = json.loads(record['bookmaker_odds'])
            rows.append(record)
        except (ValueError, TypeError):
            continue
    conn.close()
    with tempfile.TemporaryDirectory(prefix='market-features-') as tmp:
        raw, out = Path(tmp)/'rows.json', Path(tmp)/'features.json'
        raw.write_text(json.dumps(rows, separators=(',', ':')))
        subprocess.run(['node', str(source_dir/'ai_best_market_features.js'), str(raw), str(out), str(min_odds)] +
            ([engine, 'context' if context else 'baseline', '1' if engine == 'high_chance' else '6'] if engine else []), check=True)
        print(f'Feature transfer: {out.stat().st_size / 1e6:.1f} MB', flush=True)
        del rows
        data = json.loads(out.read_text())
    if not data['entries']:
        raise ValueError('No fixtures have usable real bookmaker odds and results')
    return data


def daytime(indices, times, engine):
    if engine == 'safest':
        return np.asarray(indices, dtype=int)
    i = np.asarray(indices, dtype=int)
    return i[((times[i] // 3600000 + 1) % 24) >= 9]


def day_cluster_roi(indices, y, prices, times):
    """Resample whole WAT days so ten correlated fixtures are not ten independent trials."""
    i = np.asarray(indices, dtype=int)
    days = (times[i] // 86400000) if not len(i) else ((times[i] + 3600000) // 86400000)
    unique = np.unique(days)
    if len(unique) < 2:
        return dict(days=len(unique), lower=None, upper=None)
    groups = [y[i[days == day]] * prices[i[days == day]] - 1 for day in unique]
    sums = np.array([g.sum() for g in groups]); counts = np.array([len(g) for g in groups])
    sample = np.random.default_rng(42).integers(0, len(groups), size=(2000, len(groups)))
    returns = sums[sample].sum(axis=1) / counts[sample].sum(axis=1)
    return dict(days=len(unique), lower=round(float(np.quantile(returns, .05))*100, 2),
                upper=round(float(np.quantile(returns, .95))*100, 2))


def atomic_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False))
    os.replace(tmp, path)


def replacement_window_open(report, monitoring=None, now=None):
    """Keep a historically eligible version stable long enough for forward evidence.

    Drift may retire it sooner; unqualified shadow versions do not lock learning.
    """
    if not report.get('ready_for_deployment'):
        return True
    if monitoring and monitoring.get('model_version') == report.get('version') and monitoring.get('paused'):
        return True
    try:
        created = dt.datetime.fromisoformat(report['created_at'].replace('Z', '+00:00'))
        return ((now or dt.datetime.now(dt.timezone.utc)) - created).total_seconds() >= 5 * 86400
    except (KeyError, ValueError, TypeError):
        return True


def train(args):
    source_dir = Path(__file__).resolve().parent
    output = Path(args.out).resolve(); output.mkdir(parents=True, exist_ok=True)
    engine = args.engine
    min_odds = 1.000001 if engine == 'safest' else 1.65 if engine == 'high_chance' else args.min_odds
    data = load_dataset(args.db, source_dir, args.max_matches, min_odds, engine, context=True)
    config_path = source_dir.parent/'browser-config.json'
    config = json.loads(config_path.read_text()).get('ai', {}) if config_path.exists() else {}
    blocked = data['engine_policy']['blockedMarkets']
    entries = [e for e in data['entries'] if data['markets'][e['market']] not in blocked]
    if not entries:
        raise ValueError('No eligible training markets after configured exclusions')
    print(f'{engine}: {len(entries):,} real-price market examples', flush=True)
    X = np.asarray([e['features'] for e in entries], dtype=np.float32)
    y = np.asarray([e['label'] for e in entries], dtype=np.float32)
    prices = np.asarray([e['price'] for e in entries]); fair = np.asarray([e['fair'] for e in entries])
    markets = np.asarray([e['market'] for e in entries]); times = np.asarray([e['kickoff'] for e in entries])
    rounds = np.asarray([e['round'] for e in entries]); ids = np.asarray([e['id'] for e in entries])
    train_i, cal_i, tune_i, audit_i = chronological_blocks(times, cutoffs=data['split_cutoffs'])
    best = None; comparisons = []; families = {}
    context_count = 29 if data['engine_policy'].get('contextFeatures') else 0
    feature_sets = ['baseline', 'context'] if args.features == 'compare' else [args.features]
    train_ids = list(dict.fromkeys(ids[train_i]))
    for feature_set in feature_sets:
        columns = X.shape[1] - (context_count if feature_set == 'baseline' else 0)
        matrix = X[:, :columns]
        dcal = xgb.DMatrix(matrix[cal_i])
        for window in [4000, 12000, args.max_matches]:
            allowed = set(train_ids[-window:]); tr = train_i[np.isin(ids[train_i], list(allowed))]
            _, inverse, counts = np.unique(ids[tr], return_inverse=True, return_counts=True)
            age = (times[tr].max()-times[tr]) / max(1, np.median(np.diff(np.unique(times[tr]))))
            weights = np.exp(-np.log(2)*age/400) / counts[inverse]
            dtrain = xgb.DMatrix(matrix[tr], label=y[tr], weight=weights)
            dvalid = xgb.DMatrix(matrix[cal_i], label=y[cal_i])
            model = xgb.train(dict(objective='binary:logistic', eval_metric='logloss', tree_method='hist',
                max_depth=3, eta=.05, min_child_weight=20, subsample=.85, colsample_bytree=.9,
                reg_lambda=3, reg_alpha=.2, nthread=args.threads, seed=42), dtrain,
                num_boost_round=args.rounds, evals=[(dvalid, 'calibration')], early_stopping_rounds=20, verbose_eval=False)
            raw = model.predict(dcal, iteration_range=(0, model.best_iteration+1))
            logits = np.log(np.clip(raw, 1e-6, 1-1e-6) / np.clip(1-raw, 1e-6, 1))
            platt = LogisticRegression(C=1., max_iter=500).fit(logits.reshape(-1,1), y[cal_i])
            for weight in [.25, .5, .75, 1.]:
                calibration = dict(slope=float(platt.coef_[0,0]), intercept=float(platt.intercept_[0]), model_weight=weight)
                loss = logloss(y[cal_i], calibrated(raw, calibration, fair[cal_i]))
                comparisons.append(dict(feature_set=feature_set, window=window, model_weight=weight, calibration_logloss=round(loss, 5)))
                candidate = (loss, model, calibration, window, feature_set, columns)
                if feature_set not in families or loss < families[feature_set][0]:
                    families[feature_set] = candidate
                if best is None or loss < best[0]:
                    best = candidate
            print(f'  features={feature_set}, window={window}, selected calibration loss={families[feature_set][0]:.5f}', flush=True)
    _, model, calibration, window, selected_features, columns = best
    full_X = X
    X = X[:, :columns]
    if selected_features == 'baseline' and context_count:
        data['schema_version'] -= 2
        data['engine_policy']['schemaVersion'] -= 2
        data['engine_policy'].pop('contextFeatures', None)
    raw = model.predict(xgb.DMatrix(X), iteration_range=(0, model.best_iteration+1))
    p = calibrated(raw, calibration, fair)
    ablation = {}
    for name, family in families.items():
        loss, booster, cal, _, _, count = family
        pred = calibrated(booster.predict(xgb.DMatrix(full_X[audit_i, :count]), iteration_range=(0, booster.best_iteration+1)), cal, fair[audit_i])
        ablation[name] = dict(calibration_logloss=round(loss,6), audit_logloss=round(logloss(y[audit_i],pred),6),
            audit_brier=round(float(np.mean((y[audit_i]-pred)**2)),6), audit_examples=len(audit_i), features=count)
    print('CONTEXT_ABLATION '+json.dumps(ablation), flush=True)
    policy = None if engine == 'safest' else fit_policy(daytime(tune_i, times, engine), y, prices, p, markets, rounds,
                                                       min_probability=.75 if engine == 'high_chance' else .25)
    picks = select_rounds(daytime(audit_i, times, engine), p, prices, markets, rounds, policy)
    stat = metrics(picks, y, prices, p)
    blocks = [metrics(h, y, prices, p) for h in np.array_split(np.asarray(picks, dtype=int), 2)]
    model_loss = logloss(y[audit_i], p[audit_i]); book_loss = logloss(y[audit_i], fair[audit_i])
    # Safest optimizes hit rate regardless of payout. AI Best requires measured
    # positive return on high-odds selections. Neither can bypass publication gates.
    if engine == 'safest':
        ready = stat['n'] >= 100 and stat['win_lower_bound'] >= 80 and stat['calibration_error'] <= .08 and model_loss <= book_loss + .01
    else:
        ready = stat['n'] >= 50 and stat['roi_lower_bound'] > 0 and stat['calibration_error'] <= .1 and model_loss < book_loss
        ready = ready and all(b['n'] >= 20 and b['roi'] > 0 for b in blocks)
    clustered = day_cluster_roi(picks, y, prices, times)
    if engine == 'high_chance':
        ready = ready and stat['n'] >= 100 and stat['win_lower_bound'] >= 65 and clustered['days'] >= 5 and clustered['lower'] > 0
    version = f'{engine}-{dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:6]}'
    folder = output/'adaptive_models'/version; folder.mkdir(parents=True)
    model.save_model(folder/'model.json')
    report = dict(engine=engine+'_adaptive_market_xgboost', version=version, schema_version=data['schema_version'],
        trained_on=min(window,len(set(ids[train_i]))), selected_window=window, trained_through_ms=int(times[train_i].max()),
        tuning_through_ms=int(times[tune_i].max()),
        audited_through_ms=int(times[audit_i].max()), created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        supported_markets=data['engine_policy']['markets'], blocked_markets=blocked, scopes=sorted(set(e['scope'] for e in entries)), min_odds=min_odds,
        engine_policy=data['engine_policy'], day_cluster_roi=clustered,
        selection_objective='highest_calibrated_win_probability', calibration=calibration, thresholds=policy,
        audit=stat, shadow_audit=metrics(select_rounds(audit_i,p,prices,markets,rounds),y,prices,p),
        max_source_id=int(ids.max()), audit_blocks=blocks, avg_oos_roi=stat['roi'],
        profitable_folds=sum(b['roi'] is not None and b['roi'] > 0 for b in blocks),
        model_logloss=round(model_loss, 5), bookmaker_logloss=round(book_loss, 5),
        baseline_audit=metrics(select_rounds(audit_i, fair, prices, markets, rounds), y, prices, fair),
        model_selection=comparisons, selected_features=selected_features, context_ablation=ablation,
        source_fixtures=data['source_fixtures'], training_stride=data['training_stride'],
        audit_contiguous=True, ready_for_deployment=bool(ready),
        validation='chronological train/calibration/policy/untouched audit; one pick per round; actual prices')
    manifest_path = output/f'{engine}_market_active.json'
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    promote = old is None
    reason = 'initial model; publication requires audited readiness'
    if old:
        old_report = json.loads((output/old['report']).read_text())
        novel = audit_i[times[audit_i] > old_report['audited_through_ms']]
        if len(set(ids[novel])) >= 200:
            incumbent = xgb.Booster(); incumbent.load_model(output/old['model'])
            op = calibrated(incumbent.predict(xgb.DMatrix(full_X[novel, :incumbent.num_features()]), iteration_range=(0, old['best_iteration']+1)), old_report['calibration'], fair[novel])
            report['incumbent_logloss_on_new_results'] = round(logloss(y[novel], op), 5)
            report['challenger_logloss_on_new_results'] = round(logloss(y[novel], p[novel]), 5)
            promote = logloss(y[novel], p[novel]) < logloss(y[novel], op) - .0005
            old_full = np.full(len(p), np.nan); old_full[novel] = op
            old_picks = select_rounds(daytime(novel,times,engine), old_full, prices, markets, rounds, old_report.get('thresholds'))
            new_picks = select_rounds(daytime(novel,times,engine), p, prices, markets, rounds, policy)
            old_stat = metrics(old_picks, y, prices, old_full)
            new_stat = metrics(new_picks, y, prices, p)
            report['incumbent_new_result_selections'] = old_stat
            report['challenger_new_result_selections'] = new_stat
            if old_report.get('ready_for_deployment'):
                if not ready or new_stat['n'] < (100 if engine == 'safest' else 50):
                    promote = False
                elif old_stat['win_rate'] is not None and new_stat['win_rate'] < old_stat['win_rate']:
                    promote = False
            reason = 'challenger must improve unseen-result logloss and preserve readiness'
            monitor_file = output/f'{engine}_market_monitor.json'
            monitor = json.loads(monitor_file.read_text()) if monitor_file.exists() else None
            if promote and not replacement_window_open(old_report, monitor):
                promote = False
                reason = 'incumbent forward-validation window remains open; keep version stable for five days unless drift pauses it'
        else:
            reason = 'waiting for 200 genuinely unseen fixture results before replacing incumbent'
    report['promoted'] = bool(promote); report['promotion_reason'] = reason
    shadow_selections = select_rounds(audit_i, p, prices, markets, rounds)
    unrestricted = select_rounds(audit_i, p, prices, markets, rounds, policy)
    all_selections = sorted(set(shadow_selections + unrestricted + picks))
    audit_picks = [dict(fixture_id=int(ids[i]), kickoff=int(times[i]), round=rounds[i], scope=entries[i]['scope'],
        market=data['markets'][int(markets[i])], price=float(prices[i]), probability=float(p[i]), won=bool(y[i]),
        shadow=int(i) in shadow_selections, qualified_without_midnight=int(i) in unrestricted, qualified=int(i) in picks)
        for i in all_selections]
    atomic_json(folder/'audit_picks.json', audit_picks)
    atomic_json(folder/'report.json', report)
    atomic_json(output/f'{engine}_market_candidate_report.json', report)
    if promote:
        manifest = dict(version=version, model=str((folder/'model.json').relative_to(output)),
            report=str((folder/'report.json').relative_to(output)), best_iteration=int(model.best_iteration))
        atomic_json(manifest_path, manifest)
        atomic_json(output/f'{engine}_market_report.json', report)
    print(json.dumps({k:report[k] for k in ['engine','audit','baseline_audit','model_logloss','bookmaker_logloss','ready_for_deployment','promoted','promotion_reason']}, indent=2), flush=True)
    return report


def main():
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=str(directory.parent/'databases/sportybet_archive.db'))
    parser.add_argument('--out', default=str(directory))
    parser.add_argument('--engine', choices=['safest','ai_best','high_chance'], default='ai_best')
    parser.add_argument('--min-odds', type=float, default=None)
    parser.add_argument('--max-matches', type=int, default=None)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--rounds', type=int, default=160)
    parser.add_argument('--features', choices=['compare','baseline','context'], default='compare')
    args = parser.parse_args()
    if args.max_matches is None:
        args.max_matches = 120000
    settings = directory.parent/'browser-config.json'
    if args.min_odds is None:
        args.min_odds = json.loads(settings.read_text()).get('ai', {}).get('highRiskMinOdds', 3.3) if settings.exists() else 3.3
    if args.min_odds <= 1 or args.max_matches < 2000:
        parser.error('AI Best minimum odds must exceed 1; training needs at least 2000 matches')
    # A manual retrain and the daemon must not write the same engine at once.
    lock = Path(args.out)/f'{args.engine}_market_training.lock'
    Path(args.out).mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            pid = int(lock.read_text()); os.kill(pid, 0)
        except (ValueError, ProcessLookupError):
            lock.unlink(missing_ok=True)
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        else:
            raise RuntimeError('This engine is already training in another process')
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(str(os.getpid()))
        train(args)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
