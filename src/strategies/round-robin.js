/**
 * Strategy: Weighted Round Robin
 * Cycles through available providers, weighted by their configured weight.
 * Respects exclude set.
 */

let index = 0;

function select(providers, healthChecker, excludeSet = new Set()) {
  const available = healthChecker.getAvailable().filter(p => !excludeSet.has(p.name));
  if (available.length === 0) return null;

  // Build weighted pool
  const pool = [];
  for (const p of available) {
    const count = Math.max(1, Math.ceil((p.weight || 5) / 2));
    for (let i = 0; i < count; i++) pool.push(p);
  }

  const pick = pool[index % pool.length];
  index = (index + 1) % pool.length;
  return pick;
}

module.exports = { name: 'round-robin', select };
