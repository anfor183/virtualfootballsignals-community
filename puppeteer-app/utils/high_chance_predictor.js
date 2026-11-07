/**
 * High Chance inference bridge. Independent versioned XGBoost weights,
 * real-price chronological validation and prospective drift controls.
 * Replaces legacy dual models whose typical-odds ROI was not reliable.
 */
'use strict';
const adaptive = require('./adaptive_market_predictor');
function getModelStatus() { return adaptive.getModelStatus('high_chance'); }
function isModelReady() { return getModelStatus().ready; }
function scoreRound(matchList, db) {
    if (!db) return null; // Rolling historical context is mandatory; no forecast fallback.
    const rows = matchList.map(e => ({ ...e.meta,
        predicted_probs: JSON.stringify(e.rawProbs), bookmaker_odds: JSON.stringify(e.bookOdds) }));
    const pick = adaptive.scoreRound(db, rows, { engine: 'high_chance' });
    return pick ? { market: pick.market, modelProb: pick.prob, bookOdd: pick.impliedOdd,
        ev: pick.evPct, source: pick.source, meta: pick.match, modelVersion: pick.modelVersion } : null;
}
function recommendHighChanceBet(rawProbs, bookOdds, meta, db) {
    return scoreRound([{rawProbs, bookOdds, meta}], db);
}
module.exports = { getModelStatus, isModelReady, scoreRound, recommendHighChanceBet };
