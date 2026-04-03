/**
 * EntropyScorer — measures information gain per block range.
 *
 * Purpose: make the scanner smarter about WHERE to look. Instead of scanning
 * blocks sequentially (most of which are boring token transfers), we estimate
 * the information density of each block range and prioritize high-entropy zones.
 *
 * Theory:
 *   Information gain = how much a block range changes our model of "what exists."
 *   A block that deploys 50 new contracts with novel selectors = high gain.
 *   A block with 200 Uniswap swaps and 0 deploys = near-zero gain.
 *
 * Entropy signals (per block):
 *   1. Deploy density     — contract deployments / total txs
 *   2. Selector novelty   — fraction of selectors never seen before
 *   3. Value surprise     — how unexpected are the ETH balances (KL divergence)
 *   4. Gas variance       — high gas variance = diverse operations
 *   5. Code diversity     — unique bytecode prefix count / total deploys
 *
 * Combined into a single information gain score per block range.
 * The scanner uses this to decide: scan the next sequential range, or skip
 * ahead to a predicted high-entropy zone?
 *
 * Mathematical basis:
 *   - Shannon entropy H(X) = -sum(p_i * log2(p_i)) for categorical distributions
 *   - KL divergence D_KL(P||Q) for measuring surprise vs. expected distribution
 *   - Exponential moving average for online entropy estimation without storing history
 */

const { makeLogger } = require('../logger');
const log = makeLogger('entropy');

class EntropyScorer {
  constructor(opts = {}) {
    // Accumulates running statistics for online entropy estimation.
    // We never store full history — only sufficient statistics (counts, sums).
    this.selectorCounts = new Map();     // selector -> times seen
    this.totalSelectorsObserved = 0;
    this.codeHashCounts = new Map();     // bytecode prefix (16 bytes) -> count
    this.totalCodeObserved = 0;

    // Running distribution stats for value surprise
    this.valueBuckets = new Float64Array(20); // log-scale ETH value histogram
    this.totalValueObservations = 0;

    // Per-range scores (ring buffer of last N ranges for trend detection)
    this.rangeScores = [];
    this.maxHistory = opts.maxHistory || 500;

    // EMA smoothing factor for online estimates (higher = more responsive)
    this.alpha = opts.alpha || 0.05;
    this.emaEntropy = 0;

    // Minimum samples before entropy estimates are reliable
    this.warmupBlocks = opts.warmupBlocks || 200;
    this.blocksProcessed = 0;
  }

  /**
   * Score a batch of blocks and their contracts.
   *
   * @param {object} rangeData
   * @param {number} rangeData.startBlock
   * @param {number} rangeData.endBlock
   * @param {object[]} rangeData.blocks - array of block summaries from BlockScanner
   * @param {object[]} rangeData.contracts - contracts found in this range
   * @returns {object} entropy score with component breakdown
   */
  scoreRange(rangeData) {
    const { startBlock, endBlock, blocks, contracts } = rangeData;
    const nBlocks = blocks.length || 1;

    // Component 1: Deploy density
    const totalTxs = blocks.reduce((sum, b) => sum + (b.txCount || 0), 0) || 1;
    const deployDensity = contracts.length / totalTxs;

    // Component 2: Selector novelty
    const novelty = this._selectorNovelty(contracts);

    // Component 3: Value surprise (KL divergence from expected distribution)
    const valueSurprise = this._valueSurprise(contracts);

    // Component 4: Gas variance (normalized coefficient of variation)
    const gasVariance = this._gasVariance(blocks);

    // Component 5: Code diversity
    const codeDiversity = this._codeDiversity(contracts);

    // Update running stats AFTER computing novelty (so current range
    // is scored against prior knowledge, not including itself)
    this._updateStats(contracts);

    // Weighted combination — weights reflect information value
    // Deploy density and selector novelty are strongest signals;
    // gas variance is a weaker proxy.
    const weights = {
      deployDensity: 2.0,
      selectorNovelty: 3.0,
      valueSurprise: 2.5,
      gasVariance: 1.0,
      codeDiversity: 1.5,
    };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

    const raw = (
      weights.deployDensity * deployDensity +
      weights.selectorNovelty * novelty +
      weights.valueSurprise * valueSurprise +
      weights.gasVariance * gasVariance +
      weights.codeDiversity * codeDiversity
    ) / totalWeight;

    // Sigmoid squash to [0, 1] with midpoint at the running average.
    // This makes the score RELATIVE — a range is "high entropy" compared
    // to what we've seen, not on an absolute scale.
    const score = this._relativize(raw);

    // Update EMA
    this.emaEntropy = this.alpha * raw + (1 - this.alpha) * this.emaEntropy;
    this.blocksProcessed += nBlocks;

    const result = {
      startBlock,
      endBlock,
      score,
      rawEntropy: raw,
      components: {
        deployDensity: round(deployDensity, 4),
        selectorNovelty: round(novelty, 4),
        valueSurprise: round(valueSurprise, 4),
        gasVariance: round(gasVariance, 4),
        codeDiversity: round(codeDiversity, 4),
      },
      contracts: contracts.length,
      warmup: this.blocksProcessed < this.warmupBlocks,
    };

    // Store in ring buffer
    this.rangeScores.push(result);
    if (this.rangeScores.length > this.maxHistory) {
      this.rangeScores.shift();
    }

    if (score > 0.8) {
      log.info(`HIGH ENTROPY: blocks ${startBlock}-${endBlock} score=${score.toFixed(3)} (${contracts.length} contracts, novelty=${novelty.toFixed(3)})`);
    }

    return result;
  }

  /**
   * Selector novelty: fraction of selectors in this range that we've
   * never seen before. Based on Shannon information content:
   * I(x) = -log2(P(x)) where P(x) = count(x) / total
   * High information content = rare = novel.
   */
  _selectorNovelty(contracts) {
    if (contracts.length === 0) return 0;

    let totalSelectors = 0;
    let novelSelectors = 0;
    let informationContent = 0;

    for (const c of contracts) {
      const sels = c.selectors || [];
      for (const sel of sels) {
        totalSelectors++;
        const count = this.selectorCounts.get(sel) || 0;
        if (count === 0) {
          novelSelectors++;
          // First-ever observation: maximum information content
          informationContent += 1.0;
        } else {
          // Information content: -log2(frequency)
          // Rare selectors contribute more than common ones
          const freq = count / Math.max(this.totalSelectorsObserved, 1);
          informationContent += Math.min(1, -Math.log2(freq + 1e-10) / 20);
        }
      }
    }

    if (totalSelectors === 0) return 0;

    // Average information content per selector, bounded [0, 1]
    return Math.min(1, informationContent / totalSelectors);
  }

  /**
   * Value surprise: KL divergence of observed ETH values vs. expected distribution.
   * Measures how "unexpected" the value distribution is in this range.
   *
   * Uses log-scale bucketing: bucket i covers [10^(i/4 - 3), 10^((i+1)/4 - 3)) ETH.
   * Bucket 0: [0.001, 0.0018), Bucket 12: [1, 1.78), Bucket 19: [316+)
   */
  _valueSurprise(contracts) {
    if (contracts.length === 0 || this.totalValueObservations < 10) return 0;

    // Build observed distribution for this range
    const observed = new Float64Array(20);
    let nValues = 0;

    for (const c of contracts) {
      const eth = c.ethBalance ? Number(c.ethBalance) / 1e18 : 0;
      if (eth <= 0) continue;
      const bucket = Math.min(19, Math.max(0, Math.floor((Math.log10(eth) + 3) * 4)));
      observed[bucket]++;
      nValues++;
    }

    if (nValues < 3) return 0;

    // Normalize to distributions
    const obsTotal = nValues;
    const expTotal = this.totalValueObservations;

    // KL divergence: D_KL(observed || expected)
    // With Laplace smoothing to avoid log(0)
    let kl = 0;
    for (let i = 0; i < 20; i++) {
      const p = (observed[i] + 0.5) / (obsTotal + 10);       // smoothed observed
      const q = (this.valueBuckets[i] + 0.5) / (expTotal + 10); // smoothed expected
      kl += p * Math.log2(p / q);
    }

    // Normalize: KL can be unbounded, squash to [0, 1]
    // KL > 2 bits is very surprising for this distribution
    return Math.min(1, Math.max(0, kl / 2));
  }

  /**
   * Gas variance: coefficient of variation of gasUsed across blocks.
   * High variance = diverse operation types = more interesting.
   * Uniform gas (all blocks ~15M) = mostly DEX swaps = boring.
   */
  _gasVariance(blocks) {
    if (blocks.length < 2) return 0;

    const gasValues = blocks.map(b => b.gasUsed || 0).filter(g => g > 0);
    if (gasValues.length < 2) return 0;

    const mean = gasValues.reduce((a, b) => a + b, 0) / gasValues.length;
    if (mean === 0) return 0;

    const variance = gasValues.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gasValues.length;
    const cv = Math.sqrt(variance) / mean; // coefficient of variation

    // CV of 0 = all blocks identical gas; CV of 1+ = very diverse
    // Squash to [0, 1]: tanh gives diminishing returns past CV=1
    return Math.tanh(cv);
  }

  /**
   * Code diversity: unique bytecode prefixes / total deploys.
   * If all contracts are clones (same factory), diversity is low.
   * If each contract is unique, diversity is high.
   * Uses first 32 bytes of bytecode as a fuzzy signature.
   */
  _codeDiversity(contracts) {
    if (contracts.length === 0) return 0;

    const prefixes = new Set();
    for (const c of contracts) {
      if (c.bytecode) {
        // First 32 bytes (64 hex chars) as signature
        const prefix = c.bytecode.substring(0, 66).toLowerCase();
        prefixes.add(prefix);
      } else if (c.codeSize) {
        // If no bytecode available, use codeSize as weak proxy
        prefixes.add(`size_${c.codeSize}`);
      }
    }

    // Normalized: 1.0 = every contract is unique, near 0 = all clones
    return prefixes.size / contracts.length;
  }

  /**
   * Update running statistics with new observations.
   * Called AFTER scoring so the current range is novel-relative-to-past.
   */
  _updateStats(contracts) {
    for (const c of contracts) {
      // Selector frequency
      for (const sel of (c.selectors || [])) {
        this.selectorCounts.set(sel, (this.selectorCounts.get(sel) || 0) + 1);
        this.totalSelectorsObserved++;
      }

      // Bytecode prefix frequency
      if (c.bytecode) {
        const prefix = c.bytecode.substring(0, 66).toLowerCase();
        this.codeHashCounts.set(prefix, (this.codeHashCounts.get(prefix) || 0) + 1);
        this.totalCodeObserved++;
      }

      // Value distribution
      const eth = c.ethBalance ? Number(c.ethBalance) / 1e18 : 0;
      if (eth > 0) {
        const bucket = Math.min(19, Math.max(0, Math.floor((Math.log10(eth) + 3) * 4)));
        this.valueBuckets[bucket]++;
        this.totalValueObservations++;
      }
    }
  }

  /**
   * Relativize raw entropy score against running average.
   * Uses a logistic function centered on the EMA.
   * Score > 0.5 means "more informative than average."
   */
  _relativize(raw) {
    if (this.blocksProcessed < this.warmupBlocks) {
      // During warmup, everything is novel — just normalize raw
      return Math.min(1, raw * 5);
    }
    // Logistic: 1 / (1 + exp(-k*(x - mu)))
    // k=10 gives sharp transition; mu = emaEntropy
    const k = 10;
    return 1 / (1 + Math.exp(-k * (raw - this.emaEntropy)));
  }

  /**
   * Predict which block range to scan next based on entropy trends.
   *
   * Strategy: extrapolate from past range scores to estimate which
   * UNSCANNED ranges are likely high-entropy.
   *
   * Signals:
   *   1. Periodicity — some block ranges (e.g., around major launches)
   *      cluster high-entropy. Detect periodic spikes.
   *   2. Recency bias — recent ranges are more likely to have active
   *      contracts with extractable value.
   *   3. Deploy clustering — deploys come in bursts. If range N had many
   *      deploys, range N+1 likely does too.
   *
   * @param {number[]} candidateRanges - start blocks of ranges to evaluate
   * @param {number} rangeSize - blocks per range
   * @returns {object[]} ranges sorted by predicted entropy (highest first)
   */
  predictHighEntropy(candidateRanges, rangeSize = 500) {
    if (this.rangeScores.length < 5) {
      // Not enough data — return candidates in reverse order (most recent first)
      return candidateRanges.map(s => ({
        startBlock: s,
        endBlock: s + rangeSize - 1,
        predictedScore: 0.5,
        confidence: 0,
        reason: 'insufficient_data',
      })).reverse();
    }

    // Build a simple model: entropy as a function of block number
    // Using local regression (LOESS-like) with a triangular kernel
    const predictions = candidateRanges.map(candidate => {
      let weightedSum = 0;
      let weightTotal = 0;
      let nearbyDeploys = 0;

      for (const past of this.rangeScores) {
        // Distance in block space
        const dist = Math.abs(candidate - past.startBlock);
        // Triangular kernel: closer ranges have more influence
        // Bandwidth: 50000 blocks
        const bandwidth = 50000;
        const w = Math.max(0, 1 - dist / bandwidth);
        if (w > 0) {
          weightedSum += past.rawEntropy * w;
          weightTotal += w;
          nearbyDeploys += past.contracts * w;
        }
      }

      const predictedRaw = weightTotal > 0 ? weightedSum / weightTotal : this.emaEntropy;
      const confidence = Math.min(1, weightTotal / 3); // >= 3 nearby observations = full confidence

      // Bonus for adjacency to high-deploy ranges (clustering effect)
      const deployBonus = Math.min(0.2, nearbyDeploys / 500);

      return {
        startBlock: candidate,
        endBlock: candidate + rangeSize - 1,
        predictedScore: this._relativize(predictedRaw + deployBonus),
        predictedRaw: round(predictedRaw, 4),
        confidence: round(confidence, 3),
        reason: confidence < 0.3 ? 'extrapolated' : 'interpolated',
      };
    });

    // Sort: highest predicted score first, break ties by confidence
    predictions.sort((a, b) =>
      b.predictedScore - a.predictedScore || b.confidence - a.confidence
    );

    return predictions;
  }

  /**
   * Get a scan plan: given a set of unscanned ranges, return them in
   * optimal scan order (highest expected information gain first).
   *
   * @param {number} fromBlock - start of unscanned territory
   * @param {number} toBlock - end of unscanned territory
   * @param {number} rangeSize - blocks per scan range
   * @param {number} maxRanges - max ranges to return
   * @returns {object[]} ordered scan plan
   */
  getScanPlan(fromBlock, toBlock, rangeSize = 500, maxRanges = 50) {
    const candidates = [];
    for (let b = fromBlock; b < toBlock; b += rangeSize) {
      candidates.push(b);
    }

    const predictions = this.predictHighEntropy(candidates, rangeSize);
    const plan = predictions.slice(0, maxRanges);

    const totalBlocks = plan.length * rangeSize;
    const avgScore = plan.reduce((s, p) => s + p.predictedScore, 0) / plan.length;

    log.info(`scan plan: ${plan.length} ranges (${totalBlocks} blocks), avg predicted entropy=${avgScore.toFixed(3)}`);

    return {
      ranges: plan,
      totalBlocks,
      avgPredictedEntropy: round(avgScore, 3),
      skipRate: round(1 - plan.length / candidates.length, 3),
    };
  }

  /**
   * Export running statistics for persistence across sessions.
   */
  exportState() {
    return {
      selectorCounts: Object.fromEntries(this.selectorCounts),
      totalSelectorsObserved: this.totalSelectorsObserved,
      codeHashCounts: Object.fromEntries(this.codeHashCounts),
      totalCodeObserved: this.totalCodeObserved,
      valueBuckets: Array.from(this.valueBuckets),
      totalValueObservations: this.totalValueObservations,
      emaEntropy: this.emaEntropy,
      blocksProcessed: this.blocksProcessed,
      rangeScores: this.rangeScores.slice(-100), // last 100 only
    };
  }

  /**
   * Import previously saved state (for resuming scans).
   */
  importState(state) {
    if (state.selectorCounts) {
      this.selectorCounts = new Map(Object.entries(state.selectorCounts));
    }
    this.totalSelectorsObserved = state.totalSelectorsObserved || 0;
    if (state.codeHashCounts) {
      this.codeHashCounts = new Map(Object.entries(state.codeHashCounts));
    }
    this.totalCodeObserved = state.totalCodeObserved || 0;
    if (state.valueBuckets) {
      this.valueBuckets = new Float64Array(state.valueBuckets);
    }
    this.totalValueObservations = state.totalValueObservations || 0;
    this.emaEntropy = state.emaEntropy || 0;
    this.blocksProcessed = state.blocksProcessed || 0;
    if (state.rangeScores) {
      this.rangeScores = state.rangeScores;
    }
    log.info(`imported state: ${this.blocksProcessed} blocks, ${this.selectorCounts.size} unique selectors, ${this.totalValueObservations} value observations`);
  }

  /**
   * Summary report of entropy analysis.
   */
  getReport() {
    const scores = this.rangeScores.map(r => r.score);
    const rawScores = this.rangeScores.map(r => r.rawEntropy);

    return {
      blocksProcessed: this.blocksProcessed,
      rangesScored: this.rangeScores.length,
      uniqueSelectors: this.selectorCounts.size,
      uniqueCodePrefixes: this.codeHashCounts.size,
      emaEntropy: round(this.emaEntropy, 4),
      scoreDistribution: scores.length > 0 ? {
        min: round(Math.min(...scores), 3),
        max: round(Math.max(...scores), 3),
        mean: round(scores.reduce((a, b) => a + b, 0) / scores.length, 3),
        highEntropyRanges: scores.filter(s => s > 0.7).length,
      } : null,
      topRanges: this.rangeScores
        .filter(r => r.score > 0.7)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(r => ({
          blocks: `${r.startBlock}-${r.endBlock}`,
          score: round(r.score, 3),
          contracts: r.contracts,
          novelty: r.components.selectorNovelty,
        })),
    };
  }
}

function round(val, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

module.exports = { EntropyScorer };
