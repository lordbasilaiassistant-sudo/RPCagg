/**
 * AnomalyDetector — finds contracts that are structurally weird.
 *
 * Instead of matching known exploit patterns, this module computes statistical
 * profiles of bytecode and flags contracts that deviate from the norm.
 * The weirder a contract is + the more money it holds = higher priority.
 *
 * Anomaly signals:
 *  1. Opcode distribution deviation from population baseline
 *  2. Selector rarity (custom/undocumented functions)
 *  3. Structural ratio anomalies (unusual SSTORE:SLOAD, CALL patterns)
 *  4. Code density anomalies (code-to-metadata ratio, jump density)
 *  5. ETH flow anomalies (has value but no standard withdrawal path)
 *
 * Usage:
 *   const detector = new AnomalyDetector();
 *   detector.ingestBaseline(contracts);  // feed population for baseline
 *   const score = detector.score(contract); // get weirdness score
 */

const { makeLogger } = require('../logger');
const { disassemble } = require('./exploit-patterns');
const log = makeLogger('anomaly');

// Opcodes we track for distribution profiling (grouped by function)
const OPCODE_GROUPS = {
  arithmetic:   [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b],
  comparison:   [0x10, 0x11, 0x12, 0x13, 0x14, 0x15],
  bitwise:      [0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d],
  hash:         [0x20],
  env:          [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f],
  storage:      [0x54, 0x55],
  memory:       [0x51, 0x52, 0x53, 0x59],
  flow:         [0x56, 0x57, 0x5b],
  stack:        [], // 0x60-0x9f — PUSHn, DUPn, SWAPn — counted separately
  log:          [0xa0, 0xa1, 0xa2, 0xa3, 0xa4],
  system:       [0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xfa, 0xfd, 0xfe, 0xff],
};

// Specific opcodes for ratio analysis
const OP = {
  SLOAD: 0x54, SSTORE: 0x55,
  CALL: 0xf1, STATICCALL: 0xfa, DELEGATECALL: 0xf4,
  JUMPI: 0x57, JUMPDEST: 0x5b, JUMP: 0x56,
  REVERT: 0xfd, RETURN: 0xf3, STOP: 0x00,
  ISZERO: 0x15, EQ: 0x14,
  CALLDATALOAD: 0x35, CALLDATASIZE: 0x36, CALLDATACOPY: 0x37,
  LOG0: 0xa0, LOG1: 0xa1, LOG2: 0xa2, LOG3: 0xa3, LOG4: 0xa4,
  CREATE: 0xf0, CREATE2: 0xf5,
  SELFDESTRUCT: 0xff,
  ORIGIN: 0x32, CALLER: 0x33,
  SHA3: 0x20,
};

// Well-known 4-byte selectors (ERC-20, ERC-721, OZ Ownable, common DeFi)
// Contracts with many selectors NOT in this set have custom/unknown functions.
const KNOWN_SELECTORS = new Set([
  // ERC-20
  'a9059cbb', '23b872dd', '095ea7b3', '70a08231', '18160ddd',
  'dd62ed3e', '313ce567', '95d89b41', '06fdde03', '39509351',
  'a457c2d7',
  // ERC-721
  '6352211e', 'b88d4fde', '42842e0e', 'a22cb465', 'e985e9c5',
  '01ffc9a7', '081812fc',
  // OZ Ownable / Access
  '8da5cb5b', 'f2fde38b', '715018a6', '13af4035', '79ba5097',
  // Common DeFi
  'e8e33700', 'f305d719', 'baa2abde', '02751cec', // liquidity
  '38ed1739', '8803dbee', '7ff36ab5', '18cbafe5', '5c11d795', // swaps
  'd0e30db0', '2e1a7d4d', // deposit/withdraw (WETH)
  '3ccfd60b', '853828b6', '205c2878', 'db006a75', // withdraw variants
  'e9fad8ee', 'db2e21bc', '5312ea8e', // exit/emergency
  // Proxy
  '5c60da1b', '3659cfe6', '4f1ef286', '52d1902d', '8f283970',
  // Pausing
  '8456cb59', '3f4ba83a', '5c975abb',
  // Misc common
  '40c10f19', 'a0712d68', '42966c68', '89afcb44', // mint/burn
  'be040fb0', '01681a62', '7df73e27', // sweep/rescue
]);

class AnomalyDetector {
  constructor() {
    this.baseline = null; // population statistics
    this.selectorFreqs = new Map(); // selector -> count across all contracts
    this.totalContracts = 0;
  }

  /**
   * Ingest a batch of contracts to build the population baseline.
   * Call this with ALL scanned contracts (not just funded ones) to establish
   * what "normal" looks like.
   *
   * @param {object[]} contracts — array of { address, bytecodeHex, selectors[] }
   */
  ingestBaseline(contracts) {
    const profiles = [];

    for (const c of contracts) {
      if (!c.bytecodeHex || c.bytecodeHex === '0x') continue;

      const profile = this._computeProfile(c.bytecodeHex);
      profiles.push(profile);

      // Track selector frequencies
      const selectors = c.selectors || this._extractSelectors(c.bytecodeHex);
      for (const sel of selectors) {
        this.selectorFreqs.set(sel, (this.selectorFreqs.get(sel) || 0) + 1);
      }
      this.totalContracts++;
    }

    // Compute baseline mean and stddev for each metric
    this.baseline = this._computeBaselineStats(profiles);
    log.info(`baseline computed from ${profiles.length} contracts, ${this.selectorFreqs.size} unique selectors`);
  }

  /**
   * Score a single contract for anomalousness.
   * Returns a composite weirdness score [0, 1] where 1 = maximum anomaly.
   *
   * @param {object} contract — { address, bytecodeHex, selectors[], ethBalance, tokenBalances }
   * @returns {object} { weirdnessScore, signals[], profile }
   */
  score(contract) {
    if (!contract.bytecodeHex || contract.bytecodeHex === '0x') {
      return { weirdnessScore: 0, signals: ['destroyed'], profile: null };
    }

    const profile = this._computeProfile(contract.bytecodeHex);
    const selectors = contract.selectors || this._extractSelectors(contract.bytecodeHex);
    const signals = [];
    const scores = [];

    // Signal 1: Opcode distribution deviation
    if (this.baseline) {
      const deviation = this._computeDeviation(profile);
      if (deviation > 2.0) {
        signals.push({ name: 'opcode_distribution', score: Math.min(1, deviation / 5), detail: `${deviation.toFixed(2)} stddevs from mean` });
      }
      scores.push(Math.min(1, deviation / 5));
    }

    // Signal 2: Selector rarity
    const { rarityScore, unknownSelectors, rareSelectors } = this._computeSelectorRarity(selectors);
    if (unknownSelectors.length > 0) {
      signals.push({ name: 'unknown_selectors', score: rarityScore, detail: `${unknownSelectors.length} selectors not in known ABI db: ${unknownSelectors.join(', ')}` });
    }
    if (rareSelectors.length > 0) {
      signals.push({ name: 'rare_selectors', score: Math.min(1, rareSelectors.length / 5), detail: `${rareSelectors.length} selectors seen in <1% of contracts` });
    }
    scores.push(rarityScore);

    // Signal 3: Structural ratio anomalies
    const ratioAnomalies = this._checkRatioAnomalies(profile);
    for (const anomaly of ratioAnomalies) {
      signals.push(anomaly);
      scores.push(anomaly.score);
    }

    // Signal 4: Code density
    const densityScore = this._checkCodeDensity(profile);
    if (densityScore > 0) {
      signals.push({ name: 'code_density', score: densityScore, detail: `unusual code density ratio` });
      scores.push(densityScore);
    }

    // Signal 5: ETH with no withdrawal path
    const ethBalance = typeof contract.ethBalance === 'bigint'
      ? Number(contract.ethBalance) / 1e18
      : (Number(contract.ethBalance) || 0);
    const hasWithdraw = selectors.some(s =>
      ['3ccfd60b', '2e1a7d4d', '51cff8d9', 'f3fef3a3', '853828b6'].includes(s)
    );
    const hasTransfer = selectors.some(s => s === 'a9059cbb');

    if (ethBalance > 0.001 && !hasWithdraw) {
      const noWithdrawScore = Math.min(1, ethBalance); // higher ETH = higher score
      signals.push({ name: 'funded_no_withdraw', score: noWithdrawScore, detail: `${ethBalance.toFixed(6)} ETH but no standard withdraw function` });
      scores.push(noWithdrawScore);
    }

    // Signal 6: Selector count anomaly (too few or too many)
    if (selectors.length <= 1 && ethBalance > 0) {
      signals.push({ name: 'minimal_interface', score: 0.8, detail: `only ${selectors.length} selectors but holds ETH — possible trap or custom contract` });
      scores.push(0.8);
    } else if (selectors.length > 100) {
      signals.push({ name: 'huge_interface', score: 0.5, detail: `${selectors.length} selectors — diamond proxy or complex system` });
      scores.push(0.5);
    }

    // Composite weirdness: weighted average with emphasis on highest signal
    let weirdnessScore = 0;
    if (scores.length > 0) {
      scores.sort((a, b) => b - a);
      // Top signal gets 40% weight, rest split 60%
      const topScore = scores[0];
      const avgRest = scores.length > 1
        ? scores.slice(1).reduce((a, b) => a + b, 0) / (scores.length - 1)
        : 0;
      weirdnessScore = topScore * 0.4 + avgRest * 0.6;

      // Boost by ETH balance (more money = more interesting)
      if (ethBalance > 0) {
        const ethBoost = Math.min(0.3, Math.log10(ethBalance * 100 + 1) / 10);
        weirdnessScore = Math.min(1, weirdnessScore + ethBoost);
      }
    }

    return {
      weirdnessScore: Math.round(weirdnessScore * 1000) / 1000,
      signals,
      profile: {
        opcodeCount: profile.totalOps,
        codeSize: profile.codeSize,
        selectorCount: selectors.length,
        unknownSelectorCount: unknownSelectors.length,
        ...profile.ratios,
      },
    };
  }

  /**
   * Batch score and rank contracts by weirdness.
   * Returns sorted array, weirdest first.
   */
  rankByWeirdness(contracts) {
    const results = contracts.map(c => ({
      address: c.address,
      ethBalance: c.ethBalance,
      ...this.score(c),
    }));

    return results.sort((a, b) => b.weirdnessScore - a.weirdnessScore);
  }

  // ─── Internal methods ──────────────────────────────

  _computeProfile(bytecodeHex) {
    const ops = disassemble(bytecodeHex);
    const counts = {};
    const groupCounts = {};

    // Initialize group counts
    for (const group of Object.keys(OPCODE_GROUPS)) {
      groupCounts[group] = 0;
    }
    groupCounts.push = 0; // PUSH instructions
    groupCounts.dup = 0;  // DUP instructions
    groupCounts.swap = 0; // SWAP instructions

    for (const op of ops) {
      counts[op.opcode] = (counts[op.opcode] || 0) + 1;

      // Classify into groups
      if (op.opcode >= 0x60 && op.opcode <= 0x7f) groupCounts.push++;
      else if (op.opcode >= 0x80 && op.opcode <= 0x8f) groupCounts.dup++;
      else if (op.opcode >= 0x90 && op.opcode <= 0x9f) groupCounts.swap++;
      else {
        for (const [group, opcodes] of Object.entries(OPCODE_GROUPS)) {
          if (opcodes.includes(op.opcode)) {
            groupCounts[group]++;
            break;
          }
        }
      }
    }

    const totalOps = ops.length;
    const codeSize = (bytecodeHex.replace('0x', '').length) / 2;

    // Compute key ratios
    const sloadCount = counts[OP.SLOAD] || 0;
    const sstoreCount = counts[OP.SSTORE] || 0;
    const callCount = counts[OP.CALL] || 0;
    const staticcallCount = counts[OP.STATICCALL] || 0;
    const delegatecallCount = counts[OP.DELEGATECALL] || 0;
    const jumpiCount = counts[OP.JUMPI] || 0;
    const revertCount = counts[OP.REVERT] || 0;
    const returnCount = counts[OP.RETURN] || 0;
    const logCount = (counts[OP.LOG0] || 0) + (counts[OP.LOG1] || 0) +
                     (counts[OP.LOG2] || 0) + (counts[OP.LOG3] || 0) + (counts[OP.LOG4] || 0);
    const sha3Count = counts[OP.SHA3] || 0;

    return {
      totalOps,
      codeSize,
      counts,
      groupCounts,
      ratios: {
        storageReadWrite: sloadCount > 0 ? sstoreCount / sloadCount : (sstoreCount > 0 ? Infinity : 0),
        externalCallDensity: totalOps > 0 ? (callCount + staticcallCount + delegatecallCount) / totalOps : 0,
        branchDensity: totalOps > 0 ? jumpiCount / totalOps : 0,
        revertRatio: (revertCount + returnCount) > 0 ? revertCount / (revertCount + returnCount) : 0,
        logDensity: totalOps > 0 ? logCount / totalOps : 0,
        hashDensity: totalOps > 0 ? sha3Count / totalOps : 0,
        opsPerByte: codeSize > 0 ? totalOps / codeSize : 0,
        delegatecallRatio: (callCount + staticcallCount + delegatecallCount) > 0
          ? delegatecallCount / (callCount + staticcallCount + delegatecallCount) : 0,
      },
      // Normalized group distribution
      groupDistribution: Object.fromEntries(
        Object.entries(groupCounts).map(([k, v]) => [k, totalOps > 0 ? v / totalOps : 0])
      ),
    };
  }

  _computeBaselineStats(profiles) {
    const stats = {};
    const keys = Object.keys(profiles[0]?.ratios || {});

    for (const key of keys) {
      const values = profiles.map(p => p.ratios[key]).filter(v => isFinite(v));
      if (values.length === 0) continue;

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      const stddev = Math.sqrt(variance);

      stats[key] = { mean, stddev, min: Math.min(...values), max: Math.max(...values) };
    }

    // Also compute group distribution baselines
    const groupKeys = Object.keys(profiles[0]?.groupDistribution || {});
    for (const key of groupKeys) {
      const values = profiles.map(p => p.groupDistribution[key]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      stats['group_' + key] = { mean, stddev: Math.sqrt(variance) };
    }

    return stats;
  }

  _computeDeviation(profile) {
    if (!this.baseline) return 0;

    let totalDeviation = 0;
    let count = 0;

    for (const [key, value] of Object.entries(profile.ratios)) {
      const stat = this.baseline[key];
      if (!stat || stat.stddev === 0 || !isFinite(value)) continue;

      const zScore = Math.abs((value - stat.mean) / stat.stddev);
      totalDeviation += zScore;
      count++;
    }

    return count > 0 ? totalDeviation / count : 0;
  }

  _computeSelectorRarity(selectors) {
    const unknownSelectors = [];
    const rareSelectors = [];
    let rarityTotal = 0;

    for (const sel of selectors) {
      // Check against known ABI database
      if (!KNOWN_SELECTORS.has(sel)) {
        unknownSelectors.push(sel);
      }

      // Check against population frequency
      const freq = this.selectorFreqs.get(sel) || 0;
      const prevalence = this.totalContracts > 0 ? freq / this.totalContracts : 0;
      if (prevalence < 0.01) { // seen in less than 1% of contracts
        rareSelectors.push(sel);
        rarityTotal += (1 - prevalence); // rarer = higher score
      }
    }

    const rarityScore = selectors.length > 0
      ? Math.min(1, (unknownSelectors.length / selectors.length) * 0.6 + (rareSelectors.length / selectors.length) * 0.4)
      : 0;

    return { rarityScore, unknownSelectors, rareSelectors };
  }

  _checkRatioAnomalies(profile) {
    const anomalies = [];
    const r = profile.ratios;

    // High SSTORE:SLOAD ratio — writing more than reading is unusual
    // Normal contracts read storage much more than they write.
    if (r.storageReadWrite > 1.0 && profile.counts[OP.SSTORE] > 3) {
      anomalies.push({
        name: 'high_write_ratio',
        score: Math.min(1, r.storageReadWrite / 3),
        detail: `SSTORE:SLOAD ratio ${r.storageReadWrite.toFixed(2)} — writes more than reads`,
      });
    }

    // Very high branch density — complex control flow
    if (r.branchDensity > 0.08) {
      anomalies.push({
        name: 'high_branch_density',
        score: Math.min(1, r.branchDensity / 0.15),
        detail: `${(r.branchDensity * 100).toFixed(1)}% JUMPI — unusually complex branching`,
      });
    }

    // No LOG events — either a library/utility or deliberately hiding activity
    if (profile.totalOps > 100 && r.logDensity === 0 && profile.counts[OP.CALL] > 0) {
      anomalies.push({
        name: 'no_events',
        score: 0.3,
        detail: 'Contract emits zero events despite having external calls — hiding activity?',
      });
    }

    // Very high revert ratio — mostly error paths
    if (r.revertRatio > 0.8 && profile.counts[OP.REVERT] > 5) {
      anomalies.push({
        name: 'high_revert_ratio',
        score: 0.4,
        detail: `${(r.revertRatio * 100).toFixed(0)}% of exits are REVERTs — defensive contract`,
      });
    }

    // High hash density — many storage mappings or complex data structures
    if (r.hashDensity > 0.05) {
      anomalies.push({
        name: 'high_hash_density',
        score: Math.min(1, r.hashDensity / 0.1),
        detail: `${(r.hashDensity * 100).toFixed(1)}% SHA3 — complex storage layout`,
      });
    }

    // All external calls are DELEGATECALL — pure proxy, interesting
    if (r.delegatecallRatio === 1.0 && profile.counts[OP.DELEGATECALL] > 0) {
      anomalies.push({
        name: 'pure_delegatecall',
        score: 0.6,
        detail: '100% of external calls are DELEGATECALL — pure proxy pattern',
      });
    }

    return anomalies;
  }

  _checkCodeDensity(profile) {
    // Very small code with many selectors — compressed or generated
    if (profile.codeSize < 500 && profile.totalOps > 50) {
      return 0.4;
    }
    // Very large code with very few selectors — obfuscated or single-purpose
    if (profile.codeSize > 20000 && profile.totalOps < 200) {
      return 0.5;
    }
    return 0;
  }

  _extractSelectors(bytecodeHex) {
    const ops = disassemble(bytecodeHex);
    const selectors = new Set();
    for (let i = 0; i < ops.length - 1; i++) {
      if (ops[i].opcode === 0x63 && ops[i].pushData && ops[i + 1]?.opcode === 0x14) {
        selectors.add(ops[i].pushData.toString('hex'));
      }
    }
    return [...selectors];
  }
}

module.exports = { AnomalyDetector };
