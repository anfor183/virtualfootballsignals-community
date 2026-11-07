export function formatProbability(value) {
    if (value === null || value === undefined || value === '') return '—';
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return '—';
    return `${Number(percent.toFixed(1))}%`;
}

export function roundPickPolicy(matches = [], picks = []) {
    return Object.fromEntries(['safest', 'high_value', 'ai_best_pick', 'goals'].map(type => [
        type,
        { allowed: true, code: 'allowed' }
    ]));
}

export function pickPolicyLabel(decision) {
    return 'Evaluating round fixtures';
}
