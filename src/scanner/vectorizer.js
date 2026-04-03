/**
 * Vectorizer — compresses contract analysis into fixed-size feature vectors
 * for neural network training.
 *
 * Each contract becomes a vector of numeric features that captures:
 * - Contract properties (size, age, proxy type)
 * - Financial state (ETH balance, token balances)
 * - Capability fingerprint (which function categories it has)
 * - Activity metrics (if available)
 * - Extraction potential (sim results)
 *
 * Output: JSONL where each line is { address, features: number[], labels: {} }
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../logger');
const log = makeLogger('vectorizer');

// Feature categories for selector classification
const SELECTOR_CATEGORIES = {
  transfer:    ['a9059cbb', '23b872dd', '095ea7b3'], // transfer, transferFrom, approve
  withdraw:    ['3ccfd60b', '2e1a7d4d', '51cff8d9', 'f3fef3a3', '853828b6', '205c2878'],
  deposit:     ['d0e30db0', 'b6b55f25', 'e8eda9df'],
  swap:        ['38ed1739', '8803dbee', '7ff36ab5', '18cbafe5', '5c11d795'],
  liquidity:   ['e8e33700', 'f305d719', 'baa2abde', '02751cec'],
  governance:  ['da95691a', '15373e3d', '0825f38f', 'e23a9a52'],
  admin:       ['8da5cb5b', 'f2fde38b', '715018a6', '13af4035'], // owner, transferOwnership, renounce, setOwner
  emergency:   ['db2e21bc', '5312ea8e', 'e9fad8ee'],
  upgrade:     ['3659cfe6', '4f1ef286', '52d1902d'], // upgradeTo, upgradeToAndCall, proxiableUUID
  sweep:       ['be040fb0', '01681a62', '6ea056a9', '7df73e27', '38e771ab'],
  mint:        ['40c10f19', 'a0712d68', '1249c58b'],
  burn:        ['42966c68', '89afcb44', '9dc29fac'],
  pause:       ['8456cb59', '3f4ba83a', '5c975abb'], // pause, unpause, paused
  claim:       ['4e71d92d', 'aad3ec96', '2e7ba6ef', '379607f5'],
};

class Vectorizer {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.vectors = [];
  }

  // Convert a contract analysis object into a feature vector
  vectorize(contract) {
    const features = [];

    // --- Structural features (indices 0-9) ---
    features.push(normalize(contract.codeSize || 0, 0, 50000));        // 0: code size
    features.push(contract.destroyed ? 1 : 0);                          // 1: is destroyed
    features.push(contract.isProxy ? 1 : 0);                            // 2: is proxy
    features.push(encodeProxyType(contract.proxyType));                  // 3: proxy type
    features.push(contract.isFactory ? 1 : 0);                          // 4: is factory
    features.push(contract.hasSelfdestruct ? 1 : 0);                    // 5: has selfdestruct
    features.push(normalize(contract.selectors?.length || 0, 0, 200));  // 6: selector count
    features.push(normalize(contract.extractionFunctions?.length || 0, 0, 20)); // 7: extraction fn count
    features.push(normalize(contract.gasUsed || 0, 0, 30000000));       // 8: deploy gas
    features.push(normalize(contract.blockNumber || 0, 0, 50000000));   // 9: deploy block (age proxy)

    // --- Financial features (indices 10-16) ---
    const ethBal = contract.ethBalance ? Number(contract.ethBalance) / 1e18 : 0;
    features.push(logNormalize(ethBal));                                 // 10: ETH balance (log)
    features.push(ethBal > 0 ? 1 : 0);                                  // 11: has ETH

    const tokenBals = contract.tokenBalances || {};
    features.push(logNormalize(Number(tokenBals.WETH || 0) / 1e18));     // 12: WETH balance
    features.push(logNormalize(Number(tokenBals.USDC || 0) / 1e6));      // 13: USDC balance
    features.push(logNormalize(Number(tokenBals.USDbC || 0) / 1e6));     // 14: USDbC balance
    features.push(logNormalize(Number(tokenBals.DAI || 0) / 1e18));      // 15: DAI balance
    features.push(Object.keys(tokenBals).length > 0 ? 1 : 0);           // 16: has any tokens

    // --- Capability fingerprint (indices 17-30) ---
    // For each selector category, what fraction of known selectors does this contract have?
    const sels = new Set(contract.selectors || []);
    for (const [, catSels] of Object.entries(SELECTOR_CATEGORIES)) {
      const matches = catSels.filter(s => sels.has(s)).length;
      features.push(matches / catSels.length); // 17-30: category coverage [0,1]
    }

    // --- Extraction sim features (indices 31-34) ---
    const sims = contract.simResults || [];
    const simTotal = sims.length;
    const simSuccess = sims.filter(s => s.success).length;
    const simExtraction = sims.filter(s => s.success && SELECTOR_CATEGORIES.withdraw?.includes(s.selector)).length;
    features.push(simTotal > 0 ? simSuccess / simTotal : 0);            // 31: sim success rate
    features.push(simTotal > 0 ? simExtraction / simTotal : 0);         // 32: extraction success rate
    features.push(normalize(simSuccess, 0, 50));                         // 33: successful sims count
    features.push(contract.treasure ? 1 : 0);                           // 34: labeled as treasure

    // Labels (for supervised training)
    const labels = {
      hasValue: ethBal > 0 || Object.keys(tokenBals).length > 0,
      hasCallableExtraction: simExtraction > 0,
      treasure: contract.treasure || false,
      ethValue: ethBal,
      proxyType: contract.proxyType || 'none',
    };

    const vector = {
      address: contract.address,
      deployer: contract.deployer,
      block: contract.blockNumber,
      features,
      labels,
      dim: features.length,
    };

    this.vectors.push(vector);
    return vector;
  }

  // Batch vectorize
  vectorizeAll(contracts) {
    return contracts.map(c => this.vectorize(c));
  }

  // Write vectors to JSONL file
  write(filename = 'vectors.jsonl') {
    const filePath = path.join(this.outputDir, filename);
    const stream = fs.createWriteStream(filePath);

    for (const v of this.vectors) {
      stream.write(JSON.stringify(v) + '\n');
    }

    stream.end();
    log.info(`wrote ${this.vectors.length} vectors to ${filePath} (dim=${this.vectors[0]?.dim || 0})`);
    return filePath;
  }

  // Get stats about the dataset
  getStats() {
    const withValue = this.vectors.filter(v => v.labels.hasValue).length;
    const withExtraction = this.vectors.filter(v => v.labels.hasCallableExtraction).length;
    const treasures = this.vectors.filter(v => v.labels.treasure).length;

    return {
      totalVectors: this.vectors.length,
      dimensions: this.vectors[0]?.dim || 0,
      withValue,
      withExtraction,
      treasures,
      valueRate: this.vectors.length > 0 ? (withValue / this.vectors.length * 100).toFixed(1) + '%' : '0%',
    };
  }
}

// Normalize to [0, 1]
function normalize(val, min, max) {
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

// Log normalize for financial values (handles extreme range)
function logNormalize(val) {
  if (val <= 0) return 0;
  return Math.min(1, Math.log10(val + 1) / 10); // log10(1B+1)/10 ≈ 0.9
}

// Encode proxy type as a float
function encodeProxyType(type) {
  const types = { 'eip1167-minimal': 0.1, 'eip1967': 0.2, 'transparent': 0.3, 'uups': 0.4, 'beacon': 0.5, 'diamond-eip2535': 0.6, 'delegatecall': 0.7 };
  return types[type] || 0;
}

module.exports = { Vectorizer, SELECTOR_CATEGORIES };
