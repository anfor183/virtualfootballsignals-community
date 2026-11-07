'use strict';
/** Compatibility API for the independent multi-market AI Best engine.
 * Publication uses validated real-price thresholds; failures are no-bet.
 * The Safest engine has separate model weights, calibration and versioning.
 */
const predictor = require('./adaptive_market_predictor');

function loadTeamForm(db, teamName, isHome = true, limit = 15) {
    if (!db || !teamName) return [];
    try {
        const col = isHome ? 'home_team' : 'away_team';
        const rows = db.prepare(`
            SELECT actual_ht_score, actual_score
            FROM historical_market_predictions
            WHERE ${col} = ?
              AND actual_ht_score IS NOT NULL AND actual_ht_score != ''
              AND actual_score IS NOT NULL AND actual_score LIKE '%:%'
            ORDER BY id ASC
        `).all(teamName);

        return rows.slice(-limit).map(r => {
            const [hH, hA] = r.actual_ht_score.split(':').map(Number);
            const [fH, fA] = r.actual_score.split(':').map(Number);
            const htFor = isHome ? hH : hA;
            const htAgainst = isHome ? hA : hH;
            const ftFor = isHome ? fH : fA;
            const ftAgainst = isHome ? fA : fH;
            return {
                htResult: htFor > htAgainst ? 'W' : htFor < htAgainst ? 'L' : 'D',
                ftResult: ftFor > ftAgainst ? 'W' : ftFor < ftAgainst ? 'L' : 'D',
                htScore: `${htFor}:${htAgainst}`,
                ftScore: `${fH}:${fA}`
            };
        });
    } catch (_) {
        return [];
    }
}

function predictAndRecommendSync(rawProbs, homeRecentMatches, awayRecentMatches, bookmakerOdds, context = {}) {
    if (!context.db || !context.match) return null;
    return predictor.scoreRound(context.db, [{...context.match, predicted_probs:rawProbs, bookmaker_odds:bookmakerOdds}], {engine:'ai_best'});
}

module.exports = {
    loadTeamForm,
    predictAndRecommendSync,
    predictAndRecommend: async (...args) => predictAndRecommendSync(...args),
    getModelStatus: () => predictor.getModelStatus('ai_best'),
    isModelReady: () => predictor.getModelStatus('ai_best').ready,
    scoreRound: (db,matches) => predictor.scoreRound(db,matches,{engine:'ai_best'})
};
