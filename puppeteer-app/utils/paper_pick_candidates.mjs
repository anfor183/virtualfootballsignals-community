// The same displayed candidates are used by the dashboard and the paper tracker.
// Paper candidates are observations, not signals approved by the profitability gate.
function parseObject(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value) || {}; } catch { return {}; }
}

export function buildPaperCandidates(matches) {
    const candidates = [];
    for (const match of matches) {
        const p = parseObject(match.predicted_probs);
        const odds = parseObject(match.bookmaker_odds);
        const odd = (key, index) => {
            for (const value of [odds[key], odds.htft?.[key], odds.raw?.[index]]) {
                const n = Number(value);
                if (Number.isFinite(n) && n > 1) return n;
            }
            return null; // Never invent prices when bookmaker odds are missing.
        };
        const complement = (under, over) => p[under] ?? (p[over] != null ? 100 - p[over] : null);
        const markets = [
            ['Over 1.5 Goals', p.over15Prob, 'over15', 55],
            ['Under 1.5 Goals', complement('under15Prob', 'over15Prob'), 'under15', 54],
            ['Over 2.5 Goals', p.over25Prob, 'over25', 57],
            ['Under 2.5 Goals', complement('under25Prob', 'over25Prob'), 'under25', 56],
            ['Over 3.5 Goals', p.over35Prob, 'over35', 59],
            ['Under 3.5 Goals', complement('under35Prob', 'over35Prob'), 'under35', 58],
            ['Both Teams to Score (GG)', p.ggProb, 'gg', 51],
            ['Both Teams NOT to Score (No GG)', complement('noGgProb', 'ggProb'), 'ng', 50],
            ['Home Win', p.homeWinProb, 'home', 0],
            ['Away Win', p.awayWinProb, 'away', 1],
            ['Draw', p.drawProb, 'draw', 2],
            ['1X', p.homeWinProb != null && p.drawProb != null ? Math.min(99, Number(p.homeWinProb) + Number(p.drawProb)) : null, 'dc1x', 14],
            ['X2', p.awayWinProb != null && p.drawProb != null ? Math.min(99, Number(p.awayWinProb) + Number(p.drawProb)) : null, 'x2', 12],
            ['HT/FT 1/1', p.htft11Prob, 'htft11', 3],
            ['HT/FT X/X', p.htftXXProb, 'htftXX', 7],
            ['HT/FT 2/2', p.htft22Prob, 'htft22', 11]
        ];
        for (const [market, probability, key, index] of markets) {
            const price = odd(key, index);
            if (!price || !Number.isFinite(Number(probability)) || probability <= 0 || probability > 100) continue;
            candidates.push({ ...match, market, probability: Number(probability), implied_odd: price,
                status: 'pending', record_source: 'paper_candidate' });
        }
    }
    const safest = [...candidates].sort((a, b) => b.probability - a.probability)[0];
    const highValue = candidates.filter(c => c.implied_odd >= 1.75)
        .sort((a, b) => b.probability * b.implied_odd - a.probability * a.implied_odd)[0];
    return {
        safest: safest ? { ...safest, pick_type: 'safest' } : null,
        highValue: highValue ? { ...highValue, pick_type: 'high_value' } : null
    };
}
