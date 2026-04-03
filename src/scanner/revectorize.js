/**
 * Re-vectorize — fixes stale log-normalized features in existing vector files.
 *
 * The math audit found that logNormalize used divisor=10, compressing all real
 * ETH values into [0, 0.54]. The corrected divisor is 6, giving 1.67x better
 * separation in the critical 1-1000 ETH range.
 *
 * Affected feature indices:
 *   10: ETH balance (log-normalized) — can recompute from labels.ethValue
 *   12: WETH balance (log-normalized)
 *   13: USDC balance (log-normalized)
 *   14: USDbC balance (log-normalized)
 *   15: DAI balance (log-normalized)
 *   37: callerBalanceInContract (log-normalized) — new dim, stays 0 for old vectors
 *
 * For indices 12-15: reverse old normalization (div 10) and apply new (div 6).
 * For index 10: recompute directly from labels.ethValue.
 *
 * Usage:
 *   node src/scanner/revectorize.js [--input path] [--output path]
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../logger');
const log = makeLogger('revectorize');

// Old normalization: Math.min(1, Math.log10(val + 1) / 10)
// New normalization: Math.min(1, Math.log10(val + 1) / 6)

function oldLogNormalize(val) {
  if (val <= 0) return 0;
  return Math.min(1, Math.log10(val + 1) / 10);
}

function newLogNormalize(val) {
  if (val <= 0) return 0;
  return Math.min(1, Math.log10(val + 1) / 6);
}

// Reverse old log normalization to recover the raw value
// old_norm = min(1, log10(val + 1) / 10)
// If old_norm < 1: val = 10^(old_norm * 10) - 1
// If old_norm >= 1: val was saturated, can't recover exactly (use 1e10 - 1)
function reverseOldLogNorm(normalizedVal) {
  if (normalizedVal <= 0) return 0;
  if (normalizedVal >= 1) return 1e10 - 1; // Saturated — use max
  return Math.pow(10, normalizedVal * 10) - 1;
}

function revectorize(inputPath, outputPath) {
  const lines = fs.readFileSync(inputPath, 'utf-8').trim().split('\n');
  const output = fs.createWriteStream(outputPath);

  let fixed = 0;
  let total = 0;

  for (const line of lines) {
    const vector = JSON.parse(line);
    const features = vector.features;
    const labels = vector.labels || {};
    total++;

    let changed = false;

    // Feature 10: ETH balance — recompute from labels.ethValue (most accurate)
    const ethValue = labels.ethValue || 0;
    const oldF10 = features[10];
    features[10] = newLogNormalize(ethValue);
    if (Math.abs(oldF10 - features[10]) > 1e-10) changed = true;

    // Features 12-15: token balances — reverse old norm, apply new
    for (const idx of [12, 13, 14, 15]) {
      if (features[idx] > 0) {
        const rawVal = reverseOldLogNorm(features[idx]);
        const oldVal = features[idx];
        features[idx] = newLogNormalize(rawVal);
        if (Math.abs(oldVal - features[idx]) > 1e-10) changed = true;
      }
    }

    // Pad to 53 dims if needed (old vectors are 35/38-dim, new features default to 0)
    while (features.length < 53) {
      features.push(0);
    }
    vector.dim = features.length;

    if (changed) fixed++;
    output.write(JSON.stringify(vector) + '\n');
  }

  output.end();

  log.info(`Re-vectorized ${total} vectors, ${fixed} had changed features`);
  log.info(`Output: ${outputPath}`);

  return { total, fixed };
}

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };

  const dataDir = path.resolve(__dirname, '../../data');
  const inputPath = getArg('--input', path.join(dataDir, 'vectors-1950000-2050000.jsonl'));
  const outputPath = getArg('--output', path.join(dataDir, 'vectors-1950000-2050000-fixed.jsonl'));

  log.info(`Input:  ${inputPath}`);
  log.info(`Output: ${outputPath}`);

  const stats = revectorize(inputPath, outputPath);
  console.log('\n=== RE-VECTORIZE SUMMARY ===');
  console.log(JSON.stringify(stats, null, 2));
}

module.exports = { revectorize };
