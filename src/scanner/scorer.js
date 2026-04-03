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
const { SELECTOR_CATEGORIES } = require('./vectorizer');
const log = makeLogger('scorer');

// Flatten all known selectors from vectorizer categories into a fast lookup Set.
// Any selector NOT in this set is "unknown" — our MEV edge.
const KNOWN_SELECTORS = new Set(
  Object.values(SELECTOR_CATEGORIES).flat()
);

// Weights for each dimension (tuned by hand, will be replaced by NN weights after training)
const WEIGHTS = {
  value: 3.0,
  access: 2.5,
  anomaly: 1.5,
  age: 1.0,
  vulnerability: 2.0,
  mev: 2.5,  // MEV competition adjustment — boost obscure targets, penalize obvious ones
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
      mev: this._mevScore(contract),
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

  /**
   * MEV Competition Score — models the likelihood that this opportunity has NOT
   * already been sniped by MEV bots or other searchers.
   *
   * Core insight: the easier an opportunity is to find, the more likely it's
   * already been taken. Our edge is in the OBSCURE — contracts that other
   * scanners can't classify.
   *
   * Formula: mevScore = obscurity * ageFactor * complexityBonus * (1 - patternPenalty)
   *
   * Components:
   *   obscurity      [0,1] — fraction of selectors not in any known category
   *   ageFactor      [0,1] — penalizes very new contracts, boosts old ones
   *   complexityBonus[0,1] — unusual code size, proxy chains, non-standard bytecode
   *   patternPenalty [0,1] — how well-known the contract pattern is (ERC-20, Uniswap, etc.)
   *
   * A standard ERC-20 with withdraw() deployed yesterday: mevScore ≈ 0.05 (snipeable)
   * A weird proxy with unknown selectors deployed 8 months ago: mevScore ≈ 0.85 (our sweet spot)
   */
  _mevScore(c) {
    const obscurity = this._obscurity(c);
    const ageFactor = this._mevAgeFactor(c);
    const complexityBonus = this._complexityBonus(c);
    const patternPenalty = this._patternPenalty(c);

    // Multiplicative combination: all factors must contribute.
    // (1 - patternPenalty) inverts it: high penalty = low score.
    const raw = obscurity * ageFactor * complexityBonus * (1 - patternPenalty);

    // Rescale: raw is in [0, 1] but tends to cluster low due to multiplication.
    // Apply sqrt to spread the distribution and give more differentiation.
    return Math.min(1, Math.sqrt(raw));
  }

  /**
   * Obscurity: what fraction of this contract's selectors are unknown?
   * Unknown = not in any SELECTOR_CATEGORIES from vectorizer.
   * High obscurity = MEV bots don't know what these functions do = our edge.
   */
  _obscurity(c) {
    const sels = c.selectors || [];
    if (sels.length === 0) return 0.5; // no selectors = ambiguous, moderate score

    let unknownCount = 0;
    for (const sel of sels) {
      if (!KNOWN_SELECTORS.has(sel)) unknownCount++;
    }

    // Weighted: 100% unknown = 1.0; 100% known = 0.1 (not zero — known functions
    // can still be valuable if the contract pattern itself is unusual)
    const unknownFrac = unknownCount / sels.length;
    return 0.1 + 0.9 * unknownFrac;
  }

  /**
   * MEV-adjusted age factor. Different from _ageScore:
   *   - Very new (< 1 day / ~43K blocks): PENALIZED — if nobody took the ETH
   *     in the first hours, it's likely locked/inaccessible. MEV bots hit new
   *     contracts within seconds.
   *   - Medium (1 day - 6 months): NEUTRAL — unclear signal
   *   - Old (> 6 months / ~7.8M blocks): BOOSTED — forgotten + complex = our target
   *
   * Uses a sigmoid-shaped curve:
   *   f(age) = sigmoid(k * (age - midpoint))
   *   where midpoint = 3 months, so contracts older than 3 months score > 0.5
   */
  _mevAgeFactor(c) {
    if (!c.blockNumber) return 0.5;
    const head = c._headBlock || 50000000;
    const ageBlocks = head - c.blockNumber;

    // Base: ~2 blocks/sec
    const DAY = 43200;     // ~0.5 days actually, but close enough for Base's 2s blocks
    const MONTH = DAY * 30;

    // Very new: penalty ramp
    if (ageBlocks < DAY) {
      // Linear from 0.05 (brand new) to 0.3 (1 day old)
      return 0.05 + 0.25 * (ageBlocks / DAY);
    }

    // Sigmoid: midpoint at 3 months, steepness k=4/MONTH
    // At 6 months: ~0.88; at 1 year: ~0.98; at 1 day: ~0.12
    const midpoint = 3 * MONTH;
    const k = 4 / MONTH;
    return 1 / (1 + Math.exp(-k * (ageBlocks - midpoint)));
  }

  /**
   * Complexity bonus: unusual bytecode characteristics.
   * Complex = harder for automated scanners to analyze = less competition.
   */
  _complexityBonus(c) {
    let bonus = 0.3; // baseline

    // Proxy chains add complexity (other scanners often fail on proxies)
    if (c.isProxy) bonus += 0.2;

    // Unusual code size: very small (bare vault?) or very large (complex logic)
    if (c.codeSize) {
      if (c.codeSize < 200) bonus += 0.15;        // minimal bytecode — unusual
      else if (c.codeSize > 15000) bonus += 0.15;  // very complex
    }

    // Many selectors = complex interface = harder to auto-analyze
    const nSels = c.selectors?.length || 0;
    if (nSels > 20) bonus += 0.1;
    if (nSels > 50) bonus += 0.1;

    // Has selfdestruct = nonstandard lifecycle
    if (c.hasSelfdestruct) bonus += 0.1;

    // Is a factory = CREATE2 complexity
    if (c.isFactory) bonus += 0.1;

    return Math.min(1, bonus);
  }

  /**
   * Pattern penalty: how well-known and MEV-targeted is this contract type?
   * High penalty = standard pattern = MEV bots already monitor it.
   *
   * Patterns detected by selector fingerprinting:
   *   - ERC-20 token: transfer + approve + totalSupply = very standard
   *   - Uniswap V2 pair: swap + getReserves + mint + burn = heavily monitored
   *   - Standard staking: stake + withdraw + getReward = well-known
   *   - Airdrop/claim: claim + merkle proof patterns = bot targets
   */
  _patternPenalty(c) {
    const sels = new Set(c.selectors || []);
    let penalty = 0;

    // ERC-20 fingerprint: transfer + balanceOf + approve + totalSupply
    const erc20Sigs = ['a9059cbb', '70a08231', '095ea7b3', '18160ddd'];
    const erc20Match = erc20Sigs.filter(s => sels.has(s)).length;
    if (erc20Match >= 3) penalty += 0.3;

    // Uniswap V2 pair: swap + getReserves + token0 + token1
    const uniV2Sigs = ['022c0d9f', '0902f1ac', '0dfe1681', 'd21220a7'];
    const uniMatch = uniV2Sigs.filter(s => sels.has(s)).length;
    if (uniMatch >= 3) penalty += 0.4;

    // Standard staking: stake + withdraw + getReward + earned
    const stakingSigs = ['a694fc3a', '2e1a7d4d', '3d18b912', '008cc262'];
    const stakeMatch = stakingSigs.filter(s => sels.has(s)).length;
    if (stakeMatch >= 3) penalty += 0.2;

    // Standard airdrop: claim + claimed + merkleRoot
    const airdropSigs = ['4e71d92d', '9e34070f', '2eb4a7ab'];
    const airMatch = airdropSigs.filter(s => sels.has(s)).length;
    if (airMatch >= 2) penalty += 0.2;

    // Simple withdraw-only contracts (just withdraw + owner): too obvious
    if (sels.has('3ccfd60b') && sels.has('8da5cb5b') && sels.size <= 5) {
      penalty += 0.3;
    }

    return Math.min(1, penalty);
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
