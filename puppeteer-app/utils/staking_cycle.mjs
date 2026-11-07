export const MARTINGALE_CYCLE_CAP = 7;

// Qualification keeps seven total bets. Research replays may choose a positive
// step cap, or null / blank for no cap; the base stake counts as step one.
export function normalizeStepCap(cap = MARTINGALE_CYCLE_CAP) {
    if (cap === null || cap === '') return null;
    const value = Number(cap);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Step cap must be a positive whole number or blank');
    return value;
}

export function martingaleStake(baseStake, multiplier, consecutiveLosses, cap = MARTINGALE_CYCLE_CAP) {
    cap = normalizeStepCap(cap);
    const losses = Math.max(0, Math.floor(Number(consecutiveLosses) || 0));
    return Math.max(1, Number(baseStake) * Number(multiplier) ** (cap === null ? losses : losses % cap));
}

// Option 1: Odds-adjusted dynamic recovery Martingale
// Guaranteed to recover all past losses + target base profit on any single win regardless of odds.
export function oddsAdjustedMartingaleStake(baseStake, accumulatedLoss, currentOdd, targetProfit = null, cap = MARTINGALE_CYCLE_CAP, consecutiveLosses = 0) {
    cap = normalizeStepCap(cap);
    const losses = Math.max(0, Math.floor(Number(consecutiveLosses) || 0));
    if (cap !== null && losses >= cap) {
        return Math.max(1, Number(baseStake)); // Reset cycle when cap reached
    }
    const loss = Math.max(0, Number(accumulatedLoss) || 0);
    if (loss === 0) return Math.max(1, Number(baseStake));
    const odd = Math.max(1.10, Number(currentOdd) || 1.5);
    const profit = targetProfit !== null && Number.isFinite(Number(targetProfit)) && Number(targetProfit) > 0
        ? Number(targetProfit)
        : Number(baseStake);
    const calculated = (loss + profit) / (odd - 1);
    return Math.max(1, Math.round((calculated + Number.EPSILON) * 100) / 100);
}
