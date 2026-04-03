/**
 * Strategy: Race
 * Fires the request at N healthy providers simultaneously, returns the first success.
 * Uses more bandwidth but gives lowest possible latency.
 */

const RACE_COUNT = 3; // how many providers to race

function select(providers, healthChecker) {
  const healthy = healthChecker.getHealthy();
  if (healthy.length === 0) return null;

  // Sort by latency (ascending), take top N
  const sorted = [...healthy].sort((a, b) => {
    const la = healthChecker.getState(a.name).latency;
    const lb = healthChecker.getState(b.name).latency;
    return (la === Infinity ? 9999 : la) - (lb === Infinity ? 9999 : lb);
  });

  return sorted.slice(0, RACE_COUNT);
}

module.exports = { name: 'race', select, RACE_COUNT };
