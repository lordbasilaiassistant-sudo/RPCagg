/**
 * BlockPrioritizer — lightweight pre-scan scoring using only block headers.
 *
 * Purpose: score blocks BEFORE full scanning. A full scan (eth_getBlockByNumber
 * with txs=true, then contract analysis) costs ~50-200 RPC calls per block.
 * A header fetch (txs=false) costs 1 call. This module fetches headers cheaply
 * and decides which blocks are worth the expensive full scan.
 *
 * Scoring signals (all from block header, no full tx fetch):
 *   1. Transaction count    — more txs = more potential deploys
 *   2. Gas utilization      — gasUsed/gasLimit ratio; high = complex operations
 *   3. BaseFee anomaly      — deviation from local moving average; spikes = unusual demand
 *   4. Block-over-block Δ   — sudden changes in any metric = phase transition
 *   5. Deploy estimation    — low tx count + high gas ratio = few but heavy txs = deploys
 *
 * Design philosophy:
 *   Sequential scanning: 100% of blocks, ~1% are interesting.
 *   Prioritized scanning: header-scan 100%, full-scan only the top N%.
 *   Expected speedup: 10-50x for finding interesting blocks.
 *
 * Integration with EntropyScorer:
 *   BlockPrioritizer = PRE-scan (cheap headers -> pick blocks to scan)
 *   EntropyScorer = POST-scan (full contract data -> measure what we learned)
 *   Pipeline: prioritize -> full-scan top blocks -> entropy-score results -> refine priorities
 */

const { makeLogger } = require('../logger');
const log = makeLogger('prioritizer');

// Header batch size: how many headers to fetch per RPC batch.
// Each header is a single eth_getBlockByNumber(N, false) call.
const HEADER_BATCH_SIZE = 100;

class BlockPrioritizer {
  constructor(rpcClient, opts = {}) {
    this.rpc = rpcClient;
    this.headerBatchSize = opts.headerBatchSize || HEADER_BATCH_SIZE;

    // Running statistics for relative scoring (EMA-based)
    this._ema = {
      txCount: 0,
      gasRatio: 0,
      baseFee: 0,
    };
    this._emaN = 0;           // observations counted
    this._alpha = opts.alpha || 0.02;  // EMA decay: slow adaptation to baseline

    // Previous block for delta computation
    this._prevBlock = null;

    // Stats
    this.stats = { headersFetched: 0, blocksScored: 0 };
  }

  /**
   * Fetch headers and score a block range. This is the main entry point.
   *
   * @param {number} fromBlock - start block (inclusive)
   * @param {number} toBlock - end block (inclusive)
   * @returns {object} { blocks: scored[], stats: {} }
   *   blocks sorted by score descending (most interesting first)
   */
  async prioritize(fromBlock, toBlock) {
    const headers = await this._fetchHeaders(fromBlock, toBlock);
    const scored = this._scoreAll(headers);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const interesting = scored.filter(b => b.score > 0.5).length;

    log.info(`prioritized ${total} blocks (${fromBlock}-${toBlock}): ${interesting} interesting (${(100 * interesting / total).toFixed(1)}%)`);

    return {
      blocks: scored,
      stats: {
        total,
        interesting,
        interestingPct: round(100 * interesting / Math.max(total, 1), 1),
        topScore: scored[0]?.score || 0,
        bottomScore: scored[scored.length - 1]?.score || 0,
      },
    };
  }

  /**
   * Get just the top N blocks worth full-scanning.
   *
   * @param {number} fromBlock
   * @param {number} toBlock
   * @param {number} topN - number of blocks to return (or fraction if < 1)
   * @returns {number[]} block numbers to full-scan, highest priority first
   */
  async getTopBlocks(fromBlock, toBlock, topN = 0.1) {
    const result = await this.prioritize(fromBlock, toBlock);

    // topN can be a count (>=1) or a fraction (<1)
    const count = topN >= 1
      ? Math.min(topN, result.blocks.length)
      : Math.ceil(result.blocks.length * topN);

    return result.blocks
      .slice(0, count)
      .map(b => b.number);
  }

  /**
   * Fetch block headers in batches. txs=false for minimal data.
   */
  async _fetchHeaders(from, to) {
    const headers = [];
    const blockNums = [];
    for (let n = from; n <= to; n++) blockNums.push(n);

    // Batch fetch
    for (let i = 0; i < blockNums.length; i += this.headerBatchSize) {
      const chunk = blockNums.slice(i, i + this.headerBatchSize);
      const calls = chunk.map(n => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${n.toString(16)}`, false], // false = no full tx objects
      }));

      const results = await this.rpc.batch(calls);

      for (let j = 0; j < results.length; j++) {
        const block = results[j];
        if (!block || block.error) continue;

        headers.push({
          number: parseInt(block.number, 16),
          timestamp: parseInt(block.timestamp, 16),
          txCount: block.transactions ? block.transactions.length : 0,
          gasUsed: parseInt(block.gasUsed, 16),
          gasLimit: parseInt(block.gasLimit, 16),
          baseFeePerGas: block.baseFeePerGas ? parseInt(block.baseFeePerGas, 16) : 0,
        });
      }

      this.stats.headersFetched += chunk.length;
    }

    // Sort by block number for delta computation
    headers.sort((a, b) => a.number - b.number);
    return headers;
  }

  /**
   * Score all headers. Must be called in block-number order for delta scoring.
   */
  _scoreAll(headers) {
    return headers.map(h => this._scoreBlock(h));
  }

  /**
   * Score a single block header.
   *
   * Components:
   *   1. txDensity   — transaction count relative to EMA baseline
   *   2. gasIntensity — gasUsed/gasLimit; high = complex txs
   *   3. baseFeeAnomaly — deviation from running average baseFee
   *   4. deltaScore  — block-over-block rate of change in metrics
   *   5. deploySignal — high gas + low txCount = likely deploys
   *
   * Each component is [0, 1]. Combined via weighted mean, then squashed.
   */
  _scoreBlock(header) {
    const { txCount, gasUsed, gasLimit, baseFeePerGas } = header;
    const gasRatio = gasLimit > 0 ? gasUsed / gasLimit : 0;

    // Component 1: Transaction density (relative to running average)
    // High txCount means more activity. We care about deviation from normal.
    const txSurprise = this._surprise(txCount, 'txCount');

    // Component 2: Gas intensity
    // gasRatio > 0.8 means the block is nearly full = lots of complex operations.
    // gasRatio < 0.3 means the block is mostly empty.
    // We want high gas ratio but ALSO care about surprise vs. baseline.
    const gasIntensity = gasRatio;
    const gasSurprise = this._surprise(gasRatio, 'gasRatio');

    // Component 3: BaseFee anomaly
    // BaseFee spikes indicate unusual demand — MEV activity, token launches, etc.
    const baseFeeSurprise = baseFeePerGas > 0
      ? this._surprise(baseFeePerGas, 'baseFee')
      : 0;

    // Component 4: Block-over-block delta
    // Sudden changes in txCount or gasRatio = phase transition = interesting.
    let deltaScore = 0;
    if (this._prevBlock) {
      const txDelta = Math.abs(txCount - this._prevBlock.txCount) /
        Math.max(this._prevBlock.txCount, 1);
      const gasDelta = Math.abs(gasRatio - this._prevBlock.gasRatio);
      const feeDelta = baseFeePerGas > 0 && this._prevBlock.baseFeePerGas > 0
        ? Math.abs(baseFeePerGas - this._prevBlock.baseFeePerGas) /
          Math.max(this._prevBlock.baseFeePerGas, 1)
        : 0;
      // Combine deltas: any large change is interesting
      deltaScore = Math.min(1, Math.tanh(txDelta + gasDelta * 2 + feeDelta));
    }

    // Component 5: Deploy signal
    // Contract deployments use lots of gas but are single transactions.
    // Signal: high gasRatio + moderate-to-low txCount = likely deploys.
    // Anti-signal: high txCount + high gasRatio = just many normal txs.
    const avgGasPerTx = txCount > 0 ? gasUsed / txCount : 0;
    // Deploy txs typically use 500K-5M gas. Normal txs use 21K-200K.
    // avgGasPerTx > 300K strongly suggests deploys in the block.
    const deploySignal = Math.min(1, Math.max(0, (avgGasPerTx - 100000) / 2000000));

    // Update EMA (AFTER computing surprise, so current block is scored vs. prior)
    this._updateEma(txCount, gasRatio, baseFeePerGas);

    // Store for delta computation
    this._prevBlock = { txCount, gasRatio, baseFeePerGas };
    this.stats.blocksScored++;

    // Weighted combination
    const weights = {
      txSurprise: 1.5,
      gasIntensity: 1.0,
      gasSurprise: 1.5,
      baseFeeSurprise: 2.0,
      deltaScore: 2.0,
      deploySignal: 3.0,   // Heaviest weight: deploys are what we're hunting
    };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

    const raw = (
      weights.txSurprise * txSurprise +
      weights.gasIntensity * gasIntensity +
      weights.gasSurprise * gasSurprise +
      weights.baseFeeSurprise * baseFeeSurprise +
      weights.deltaScore * deltaScore +
      weights.deploySignal * deploySignal
    ) / totalWeight;

    // Sigmoid squash centered at 0.3 (most blocks score below this)
    // k=12 gives a sharp but smooth transition
    const score = 1 / (1 + Math.exp(-12 * (raw - 0.3)));

    return {
      number: header.number,
      timestamp: header.timestamp,
      score: round(score, 4),
      raw: round(raw, 4),
      components: {
        txSurprise: round(txSurprise, 3),
        gasIntensity: round(gasIntensity, 3),
        gasSurprise: round(gasSurprise, 3),
        baseFeeSurprise: round(baseFeeSurprise, 3),
        deltaScore: round(deltaScore, 3),
        deploySignal: round(deploySignal, 3),
      },
      header: {
        txCount,
        gasUsed,
        gasRatio: round(gasRatio, 4),
        baseFeePerGas,
        avgGasPerTx: Math.round(avgGasPerTx),
      },
    };
  }

  /**
   * Compute surprise: how far a value deviates from its running EMA.
   * Uses absolute z-score approximation: |x - mu| / (mu + epsilon).
   * Returns [0, 1] via tanh squashing.
   *
   * During warmup (< 50 observations), returns a moderate score (0.3)
   * because we can't yet distinguish signal from noise.
   */
  _surprise(value, metric) {
    if (this._emaN < 50) return 0.3; // warmup: no opinion yet

    const mu = this._ema[metric] || 1;
    const deviation = Math.abs(value - mu) / (Math.abs(mu) + 1e-10);
    // tanh squash: deviation of 1x the mean -> 0.76; 2x -> 0.96
    return Math.tanh(deviation);
  }

  /**
   * Update exponential moving averages.
   */
  _updateEma(txCount, gasRatio, baseFee) {
    if (this._emaN === 0) {
      // Initialize
      this._ema.txCount = txCount;
      this._ema.gasRatio = gasRatio;
      this._ema.baseFee = baseFee;
    } else {
      const a = this._alpha;
      this._ema.txCount = a * txCount + (1 - a) * this._ema.txCount;
      this._ema.gasRatio = a * gasRatio + (1 - a) * this._ema.gasRatio;
      this._ema.baseFee = a * baseFee + (1 - a) * this._ema.baseFee;
    }
    this._emaN++;
  }

  /**
   * Export/import state for persistence between sessions.
   */
  exportState() {
    return {
      ema: { ...this._ema },
      emaN: this._emaN,
      prevBlock: this._prevBlock ? { ...this._prevBlock } : null,
      stats: { ...this.stats },
    };
  }

  importState(state) {
    if (state.ema) this._ema = { ...state.ema };
    this._emaN = state.emaN || 0;
    this._prevBlock = state.prevBlock || null;
    if (state.stats) this.stats = { ...state.stats };
    log.info(`imported state: ${this._emaN} observations, EMA txCount=${this._ema.txCount?.toFixed(1)}, gasRatio=${this._ema.gasRatio?.toFixed(3)}`);
  }

  /**
   * Summary report.
   */
  getReport() {
    return {
      headersFetched: this.stats.headersFetched,
      blocksScored: this.stats.blocksScored,
      ema: {
        txCount: round(this._ema.txCount, 1),
        gasRatio: round(this._ema.gasRatio, 4),
        baseFee: round(this._ema.baseFee, 0),
      },
      observations: this._emaN,
    };
  }
}

function round(val, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

module.exports = { BlockPrioritizer };
