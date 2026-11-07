// A failed web-bridge poll can resolve to an error object rather than reject.
// Keep the last complete sample so error payloads never enter renderer state.
export function nextSystemStats(previous, incoming) {
    const system = incoming?.system, bots = incoming?.bots;
    const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!system || !bots || !['freeMem', 'totalMem', 'freeDisk', 'totalDisk', 'cpuCores'].every(key => nonnegative(system[key]))
        || system.totalMem <= 0 || system.cpuCores < 1 || !['ram', 'disk', 'count'].every(key => nonnegative(bots[key]))) return previous;
    return incoming;
}
