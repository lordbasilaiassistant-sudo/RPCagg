/**
 * Labeler — corrects training labels by detecting false positive categories.
 *
 * Reads raw vectors from vectorizer output and the treasure report,
 * applies heuristic rules to re-classify false positives, and writes
 * corrected labeled vectors to data/labeled-vectors.jsonl.
 *
 * False positive categories:
 *   - "view-only"           : only profitable action is a view function (owner(), etc.)
 *   - "locked"              : owner is zero/dead address — funds permanently locked
 *   - "staking-no-position" : has withdraw/exit but we have no staked position
 *   - "dust-trap"           : fake token balances (absurdly large) or negligible ETH
 *   - "dust"                : real ETH but below gas-cost threshold
 *
 * Usage:
 *   node src/scanner/labeler.js [--vectors path] [--treasures path] [--output path]
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../logger');
const log = makeLogger('labeler');

// --- Constants ---

// View-only selectors that never move value
const VIEW_SELECTORS = new Set([
  '8da5cb5b', // owner()
  '715018a6', // renounceOwnership()
  '5c975abb', // paused()
  '313ce567', // decimals()
  '06fdde03', // name()
  '95d89b41', // symbol()
  '18160ddd', // totalSupply()
  '70a08231', // balanceOf(address)
  'dd62ed3e', // allowance(address,address)
]);

// Dead/zero addresses that indicate locked ownership
const DEAD_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
]);

// Staking/withdrawal selectors — require a position to extract value
const STAKING_SELECTORS = new Set([
  'e9fad8ee', // exit()
  '2e1a7d4d', // withdraw(uint256)
  '3ccfd60b', // withdraw()
  '853828b6', // withdrawTo(address,uint256)
]);

// Minimum ETH balance worth extracting (must cover gas costs)
const DUST_THRESHOLD_ETH = 0.001;

// WETH has 18 decimals; anything above 1e30 raw is clearly fake
const FAKE_TOKEN_THRESHOLD = 1e30;

class Labeler {
  constructor() {
    this.stats = {
      total: 0,
      originalTreasures: 0,
      correctedFalsePositives: 0,
      remainingTreasures: 0,
      categories: {
        'view-only': 0,
        'locked': 0,
        'staking-no-position': 0,
        'dust-trap': 0,
        'dust': 0,
      },
      negatives: 0,
    };
  }

  /**
   * Load treasure report to build a lookup of treasure addresses
   * with their profitableActions and metadata.
   */
  loadTreasureReport(treasurePath) {
    const raw = JSON.parse(fs.readFileSync(treasurePath, 'utf-8'));
    const map = new Map();
    for (const t of raw.treasures || []) {
      map.set(t.address.toLowerCase(), t);
    }
    log.info(`loaded ${map.size} treasures from report`);
    return map;
  }

  /**
   * Classify a treasure as a false positive category, or null if it's genuine.
   */
  classifyTreasure(treasure) {
    const actions = treasure.profitableActions || [];
    const ethBalance = parseFloat((treasure.ethBalance || '0').replace(' ETH', ''));

    // Check 1: Are ALL profitable actions view-only functions?
    const allViewOnly = actions.length > 0 &&
      actions.every(a => VIEW_SELECTORS.has(a.selector));

    // Check 2: Is the owner a dead/zero address? (locked funds)
    const ownerAction = actions.find(a => a.selector === '8da5cb5b');
    let isLocked = false;
    if (ownerAction && ownerAction.result) {
      // owner() returns abi-encoded address — last 40 hex chars
      const ownerAddr = '0x' + ownerAction.result.slice(-40).toLowerCase();
      isLocked = DEAD_ADDRESSES.has(ownerAddr);
    }

    // Check 3: Staking contract with no position
    const hasStakingOnly = actions.some(a => STAKING_SELECTORS.has(a.selector));
    const hasNoRealExtraction = actions.every(a =>
      VIEW_SELECTORS.has(a.selector) || STAKING_SELECTORS.has(a.selector)
    );

    // Check 4: Dust trap — fake token balances
    const tokenBals = treasure.tokenBalances || {};
    let hasFakeTokens = false;
    for (const [, val] of Object.entries(tokenBals)) {
      const num = typeof val === 'string' ? parseFloat(val) : Number(val);
      if (num > FAKE_TOKEN_THRESHOLD) {
        hasFakeTokens = true;
        break;
      }
    }

    // Check 5: Dust — real but negligible ETH
    const isDust = ethBalance > 0 && ethBalance < DUST_THRESHOLD_ETH && !hasFakeTokens;

    // Priority ordering: locked > dust-trap > staking-no-position > dust > view-only
    if (isLocked) return 'locked';
    if (hasFakeTokens) return 'dust-trap';
    if (hasStakingOnly && hasNoRealExtraction && ethBalance > 0) return 'staking-no-position';
    if (isDust) return 'dust';
    if (allViewOnly) return 'view-only';

    return null; // Might be a genuine treasure
  }

  /**
   * Process all vectors: read raw vectors, cross-reference treasure report,
   * apply corrected labels, write output.
   */
  labelAll(vectorsPath, treasurePath, outputPath) {
    const treasureMap = this.loadTreasureReport(treasurePath);

    const input = fs.readFileSync(vectorsPath, 'utf-8').trim().split('\n');
    const output = fs.createWriteStream(outputPath);

    for (const line of input) {
      const vector = JSON.parse(line);
      const addr = vector.address.toLowerCase();
      this.stats.total++;

      // Start with existing labels
      const labels = { ...vector.labels };

      if (labels.treasure) {
        this.stats.originalTreasures++;
      }

      // Check if this address was in the treasure report
      const treasure = treasureMap.get(addr);

      if (treasure) {
        const falsePositiveCategory = this.classifyTreasure(treasure);

        if (falsePositiveCategory) {
          // Correct the label: this is NOT a treasure
          labels.treasure = false;
          labels.falsePositiveCategory = falsePositiveCategory;
          labels.originalTreasure = true; // Track that it was originally flagged

          // Also correct feature index 34 (treasure flag in the vector)
          vector.features[34] = 0;

          this.stats.correctedFalsePositives++;
          this.stats.categories[falsePositiveCategory]++;

          log.info(`${addr} reclassified: ${falsePositiveCategory} (ETH: ${treasure.ethBalance})`);
        } else {
          // Genuine treasure — keep the label
          labels.treasure = true;
          labels.falsePositiveCategory = null;
          this.stats.remainingTreasures++;
          log.info(`${addr} confirmed treasure (ETH: ${treasure.ethBalance})`);
        }
      } else {
        // Not in treasure report — negative example
        labels.falsePositiveCategory = null;
        labels.originalTreasure = false;
        this.stats.negatives++;
      }

      vector.labels = labels;
      output.write(JSON.stringify(vector) + '\n');
    }

    output.end();

    log.info('--- Labeling complete ---');
    log.info(`total vectors:           ${this.stats.total}`);
    log.info(`original treasures:      ${this.stats.originalTreasures}`);
    log.info(`corrected false positives: ${this.stats.correctedFalsePositives}`);
    log.info(`remaining true treasures: ${this.stats.remainingTreasures}`);
    log.info(`negatives:               ${this.stats.negatives}`);
    log.info('false positive breakdown:');
    for (const [cat, count] of Object.entries(this.stats.categories)) {
      if (count > 0) log.info(`  ${cat}: ${count}`);
    }

    return this.stats;
  }
}

// --- CLI entrypoint ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };

  const dataDir = path.resolve(__dirname, '../../data');
  const vectorsPath = getArg('--vectors', path.join(dataDir, 'vectors-1950000-2050000.jsonl'));
  const treasurePath = getArg('--treasures', path.join(dataDir, 'treasure-1950000-2050000.json'));
  const outputPath = getArg('--output', path.join(dataDir, 'labeled-vectors.jsonl'));

  log.info(`vectors:   ${vectorsPath}`);
  log.info(`treasures: ${treasurePath}`);
  log.info(`output:    ${outputPath}`);

  const labeler = new Labeler();
  const stats = labeler.labelAll(vectorsPath, treasurePath, outputPath);

  console.log('\n=== LABELING SUMMARY ===');
  console.log(JSON.stringify(stats, null, 2));
}

module.exports = { Labeler, VIEW_SELECTORS, DEAD_ADDRESSES, STAKING_SELECTORS };
