/**
 * Strategy: Weighted Round Robin
 * Cycles through healthy providers, weighted by their configured weight.
 */

let index = 0;

function select(providers, healthChecker) {
  const healthy = healthChecker.getHealthy();
  if (healthy.length === 0) return null;

  // Build weighted pool
  const pool = [];
  for (const p of healthy) {
    const count = Math.max(1, Math.ceil((p.weight || 5) / 2));
    for (let i = 0; i < count; i++) pool.push(p);
  }

  const pick = pool[index % pool.length];
  index = (index + 1) % pool.length;
  return pick;
}

module.exports = { name: 'round-robin', select };
