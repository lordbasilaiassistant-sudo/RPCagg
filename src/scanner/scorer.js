/**
 * Scorer — real-time contract scoring without the full neural network.
 * Uses a heuristic ensemble that approximates TreasureNet's behavior.
 * Runs inline during scanning — no Python dependency required.
 *
 * Scoring dimensions:
 * 1. Value score    — how much money is in the contract
 * 2. Access score   — how many extraction functions are callable
 * 3. Anomaly score  — how unusual is this contract's structure
 * 4. Age score      — older = more likely forgotten
 * 5. Owner score    — is the owner dead/dormant?
 *
 * Combined treasure score: weighted product of all dimensions.
 */

const { makeLogger } = require('../logger');
const log = makeLogger('scorer');

// Weights for each dimension (tuned by hand, will be replaced by NN weights after training)
const WEIGHTS = {
  value: 3.0,
  access: 2.5,
  anomaly: 1.5,
  age: 1.0,
  vulnerability: 2.0,
};

// Known high-value extraction selectors (ordered by extraction likelihood)
const EXTRACTION_POWER = {
  '3ccfd60b': 10, // withdraw()
  '853828b6': 10, // withdrawAll()
  '2e1a7d4d': 8,  // withdraw(uint256)
  'e9fad8ee': 9,  // exit()
  'db2e21bc': 9,  // emergencyWithdraw()
  'be040fb0': 8,  // sweep()
  '01681a62': 8,  // sweep(address)
  '51cff8d9': 7,  // withdraw(address)
  'f3fef3a3': 7,  // withdraw(address,uint256)
  '7df73e27': 6,  // rescue(address)
  '38e771ab': 6,  // rescue()
  'a9059cbb': 3,  // transfer(address,uint256) — only if we're the owner
  'f2fde38b': 5,  // transferOwnership(address)
};

class Scorer {
  constructor() {
    this.scored = [];
    this.thresholds = { hot: 0.7, warm: 0.4, cold: 0.1 };
  }

  score(contract) {
    const scores = {
      value: this._valueScore(contract),
      access: this._accessScore(contract),
      anomaly: this._anomalyScore(contract),
      age: this._ageScore(contract),
      vulnerability: this._vulnerabilityScore(contract),
    };

    // Weighted power mean (p=0.5) — less punitive than geometric mean when
    // some dimensions are zero. Geometric mean kills the score if ANY dimension
    // is zero; power mean with p<1 degrades gracefully.
    // Math: M_p = (sum(w_i * x_i^p) / sum(w_i))^(1/p)
    const p = 0.5;
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [dim, weight] of Object.entries(WEIGHTS)) {
      weightedSum += Math.pow(Math.max(scores[dim], 0), p) * weight;
      totalWeight += weight;
    }
    const combined = Math.pow(weightedSum / totalWeight, 1 / p);

    const result = {
      address: contract.address,
      combined: Math.min(1, combined),
      dimensions: scores,
      tier: combined >= this.thresholds.hot ? 'HOT'
           : combined >= this.thresholds.warm ? 'WARM'
           : combined >= this.thresholds.cold ? 'COLD'
           : 'DEAD',
    };

    this.scored.push(result);

    if (result.tier === 'HOT') {
      log.info(`HOT TARGET: ${contract.address} (score: ${result.combined.toFixed(3)})`);
      log.info(`  ${JSON.stringify(scores)}`);
    }

    return result;
  }

  _valueScore(c) {
    const eth = c.ethBalance ? Number(c.ethBalance) / 1e18 : 0;
    const hasTokens = c.tokenBalances && Object.keys(c.tokenBalances).length > 0;

    if (eth >= 10) return 1.0;
    if (eth >= 1) return 0.8;
    if (eth >= 0.1) return 0.5;
    if (eth >= 0.01) return 0.3;
    if (hasTokens) return 0.2;
    return 0;
  }

  _accessScore(c) {
    if (!c.extractionFunctions || c.extractionFunctions.length === 0) return 0;

    let score = 0;
    for (const fn of c.extractionFunctions) {
      const power = EXTRACTION_POWER[fn.selector] || 1;
      score += power;
    }

    // Check sim results for actual callability
    if (c.simResults) {
      const successfulExtractions = c.simResults.filter(s =>
        s.success && EXTRACTION_POWER[s.selector]
      );
      if (successfulExtractions.length > 0) {
        score *= 2; // double score if any extraction actually succeeds in sim
      }
    }

    return Math.min(1, score / 20);
  }

  _anomalyScore(c) {
    let anomaly = 0;

    // Unusual code size (very small or very large)
    if (c.codeSize && (c.codeSize < 100 || c.codeSize > 30000)) anomaly += 0.2;

    // Has selfdestruct
    if (c.hasSelfdestruct) anomaly += 0.3;

    // Is a proxy but implementation slot is empty (uninitialized?)
    if (c.isProxy && !c.implementation) anomaly += 0.4;

    // Very few selectors (possibly a bare vault)
    if (c.selectors && c.selectors.length <= 3) anomaly += 0.2;

    // Has value but no owner function (might be ownerless)
    const hasOwner = c.selectors?.includes('8da5cb5b');
    if (c.ethBalance > 0n && !hasOwner) anomaly += 0.3;

    return Math.min(1, anomaly);
  }

  _ageScore(c) {
    if (!c.blockNumber) return 0;
    // Older = higher score (more likely forgotten)
    // Use current head estimate: ~2 blocks/sec * 86400 * 365 ≈ 63M blocks/year
    // Base launched mid-2023, so head ≈ blockNumber of most recent scan.
    // We normalize relative to max observed block rather than hardcoding.
    const HEAD_ESTIMATE = c._headBlock || 50000000; // pass in or fallback
    const age = HEAD_ESTIMATE - c.blockNumber;
    const maxAge = HEAD_ESTIMATE; // age relative to chain start
    if (maxAge <= 0) return 0;
    // Sigmoid-like curve: rapid rise for older contracts, plateau near 1.0
    // age/maxAge in [0,1], mapped through x^0.3 for diminishing returns
    return Math.min(1.0, Math.pow(Math.max(0, age / maxAge), 0.3));
  }

  _vulnerabilityScore(c) {
    let vuln = 0;

    // Uninitialized proxy
    if (c.isProxy && !c.implementation) vuln += 0.5;

    // Has selfdestruct + value
    if (c.hasSelfdestruct && c.ethBalance > 0n) vuln += 0.4;

    // Factory with value (might have CREATE2 drain)
    if (c.isFactory && c.ethBalance > 0n) vuln += 0.2;

    // Has transferOwnership + value
    const hasTransferOwner = c.selectors?.includes('f2fde38b');
    if (hasTransferOwner && c.ethBalance > 0n) vuln += 0.3;

    // Has renounceOwnership (owner gave up control — who has it now?)
    const hasRenounce = c.selectors?.includes('715018a6');
    if (hasRenounce) vuln += 0.1;

    return Math.min(1, vuln);
  }

  getTopTargets(n = 20) {
    return [...this.scored]
      .sort((a, b) => b.combined - a.combined)
      .slice(0, n);
  }

  getReport() {
    const hot = this.scored.filter(s => s.tier === 'HOT').length;
    const warm = this.scored.filter(s => s.tier === 'WARM').length;
    const cold = this.scored.filter(s => s.tier === 'COLD').length;
    const dead = this.scored.filter(s => s.tier === 'DEAD').length;

    return {
      total: this.scored.length,
      hot, warm, cold, dead,
      topTargets: this.getTopTargets(10),
    };
  }
}

module.exports = { Scorer };
