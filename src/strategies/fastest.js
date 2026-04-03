/**
 * Strategy: Fastest Available
 * Picks the available provider with the lowest smoothed latency.
 * Respects exclude set so retries never go back to failed providers.
 */

function select(providers, healthChecker, excludeSet = new Set()) {
  const available = healthChecker.getAvailable();
  if (available.length === 0) return null;

  let best = null;
  let bestScore = Infinity;

  for (const p of available) {
    if (excludeSet.has(p.name)) continue;

    const s = healthChecker.getState(p.name);
    // Use smoothed latency for stability, fall back to raw
    const lat = s.smoothedLatency !== Infinity ? s.smoothedLatency : (s.latency !== Infinity ? s.latency : 9999);
    // Weight bias + penalize high inflight count
    const inflightPenalty = s.inflight * 50;
    const score = (lat + inflightPenalty) / (p.weight || 1);

    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

module.exports = { name: 'fastest', select };
