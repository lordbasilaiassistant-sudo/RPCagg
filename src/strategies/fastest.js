/**
 * Strategy: Fastest Healthy
 * Picks the healthy provider with the lowest recent latency.
 */

function select(providers, healthChecker) {
  const healthy = healthChecker.getHealthy();
  if (healthy.length === 0) return null;

  let best = null;
  let bestLatency = Infinity;

  for (const p of healthy) {
    const s = healthChecker.getState(p.name);
    const effectiveLatency = s.latency === Infinity ? 9999 : s.latency;
    // Weight bias: lower latency * (1 / weight) favors higher-weight providers
    const score = effectiveLatency / (p.weight || 1);
    if (score < bestLatency) {
      bestLatency = score;
      best = p;
    }
  }

  return best;
}

module.exports = { name: 'fastest', select };
