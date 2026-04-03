/**
 * Strategy: Race
 * Fires at N available providers simultaneously, returns first success.
 * Respects exclude set.
 */

const RACE_COUNT = 3;

function select(providers, healthChecker, excludeSet = new Set()) {
  const available = healthChecker.getAvailable().filter(p => !excludeSet.has(p.name));
  if (available.length === 0) return null;

  // Sort by smoothed latency (ascending), take top N
  const sorted = [...available].sort((a, b) => {
    const sa = healthChecker.getState(a.name);
    const sb = healthChecker.getState(b.name);
    const la = sa.smoothedLatency !== Infinity ? sa.smoothedLatency : 9999;
    const lb = sb.smoothedLatency !== Infinity ? sb.smoothedLatency : 9999;
    return la - lb;
  });

  return sorted.slice(0, RACE_COUNT);
}

module.exports = { name: 'race', select, RACE_COUNT };
