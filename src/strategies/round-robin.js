/**
 * Strategy: Weighted Round Robin
 * Cycles through available providers, weighted by their configured weight.
 * Respects exclude set. Index state is per-module (singleton pattern matches
 * the Router's single-strategy-at-a-time design).
 */

// Atomic index — safe because Node.js is single-threaded.
// All async concurrency yields at await points, not mid-increment.
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

  if (pool.length === 0) return null;
  const pick = pool[index % pool.length];
  index = (index + 1) % Number.MAX_SAFE_INTEGER;
  return pick;
}

// Allow resetting index for testing
function reset() { index = 0; }

module.exports = { name: 'round-robin', select, reset };
