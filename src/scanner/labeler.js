/**
 * Labeler — corrects training labels by detecting false positive categories
 * and adds exploit-informed ground truth from storage/deployer/exploit analysis.
 *
 * False positive categories (funds NOT extractable by us):
 *   - "view-only"           : only profitable action is a view function (owner(), etc.)
 *   - "locked_renounced"    : owner is zero address — renounced via renounceOwnership()
 *   - "locked_burned"       : owner is 0xdead or similar burn address
 *   - "deployer_only"       : extraction requires being the deployer (we're not)
 *   - "staking-no-position" : has withdraw/exit but we have no staked position
 *   - "dust-trap"           : fake token balances (absurdly large) or negligible ETH
 *   - "dust"                : real ETH but below gas-cost threshold
 *
 * Exploit-informed labels (vulnerability targets, NOT direct treasures):
 *   - "reinit_vulnerable"   : has callable initializer + proxy, may be re-initializable
 *   - "metamorphic"         : uses CREATE2 + SELFDESTRUCT, code can be replaced
 *
 * Enrichment labels applied to ALL contracts (for neural net ground truth):
 *   - ownerType             : renounced | burned | deployer | third_party | unknown
 *   - deployerType          : serial_deployer | factory | dead | dormant | normal | unknown
 *   - hasVulnerability      : boolean — any exploit pattern detected
 *   - isMetamorphic         : boolean — CREATE2 + SELFDESTRUCT pattern
 *   - isReinitializable     : boolean — callable initializer detected
 *
 * Usage:
 *   node src/scanner/labeler.js [--vectors path] [--treasures path] [--output path]
 *     [--exploits path] [--storage path] [--deployers path]
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

// Renounced ownership — zero address variants (renounceOwnership() sets owner to 0x0)
const RENOUNCED_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000001',
]);

// Burned ownership — dead/burn address variants (manual transfer to burn addr)
const BURNED_ADDRESSES = new Set([
  '0x000000000000000000000000000000000000dead',
  '0x00000000000000000000000000000000deadbeef',
  '0xdead000000000000000000000000000000000000',
]);

// Combined set for backwards compat
const DEAD_ADDRESSES = new Set([...RENOUNCED_ADDRESSES, ...BURNED_ADDRESSES]);

// Initializer selectors — re-initialization vulnerability
const INITIALIZER_SELECTORS = new Set([
  '8129fc1c', 'c4d66de8', 'f8c8765e', 'c0c53b8b',
  '485cc955', '1459457a', 'fe4b84df', 'da35a26f',
  '4cd88b76', '439fab91',
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
        'locked_renounced': 0,
        'locked_burned': 0,
        'staking-no-position': 0,
        'dust-trap': 0,
        'dust': 0,
        'deployer_only': 0,
        'reinit_vulnerable': 0,
        'metamorphic': 0,
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
   *
   * Enriched with team findings:
   *   - locked_renounced: owner is zero address (renounced ownership)
   *   - locked_burned: owner is dead/burn address
   *   - deployer_only: extraction functions are owner-gated and owner == deployer
   *   - reinit_vulnerable: has callable initializer (different from "treasure" — it's
   *     exploitable but through re-init, not direct extraction)
   *   - metamorphic: CREATE2 + SELFDESTRUCT pattern — code can be replaced
   */
  classifyTreasure(treasure, vectorData) {
    const actions = treasure.profitableActions || [];
    const ethBalance = parseFloat((treasure.ethBalance || '0').replace(' ETH', ''));

    // Check 1: Are ALL profitable actions view-only functions?
    const allViewOnly = actions.length > 0 &&
      actions.every(a => VIEW_SELECTORS.has(a.selector));

    // Check 2: Is the owner a dead/zero address? (locked funds)
    // Enriched: distinguish renounced vs burned
    const ownerAction = actions.find(a => a.selector === '8da5cb5b');
    let ownerAddr = null;
    let isLocked = false;
    let lockType = null;
    if (ownerAction && ownerAction.result) {
      ownerAddr = '0x' + ownerAction.result.slice(-40).toLowerCase();
      if (RENOUNCED_ADDRESSES.has(ownerAddr)) {
        isLocked = true;
        lockType = 'locked_renounced';
      } else if (BURNED_ADDRESSES.has(ownerAddr)) {
        isLocked = true;
        lockType = 'locked_burned';
      }
    }

    // Check 3: Deployer-only — owner == deployer and extraction is owner-gated
    // The extraction exists but only the original deployer can call it
    const deployer = (treasure.deployer || vectorData?.deployer || '').toLowerCase();
    const isDeployerOwned = ownerAddr && deployer && ownerAddr === deployer;
    const hasOwnerGatedExtraction = actions.some(a =>
      !VIEW_SELECTORS.has(a.selector) && !STAKING_SELECTORS.has(a.selector)
    );

    // Check 4: Re-initialization vulnerability — has callable initializer
    // This is NOT a direct extraction — it's a vulnerability that could be exploited
    // to take ownership, but the treasure label is misleading
    const selectors = (treasure.selectors || vectorData?.selectors || []);
    const hasCallableInit = selectors.some(s => INITIALIZER_SELECTORS.has(s));
    // Support both old exploitResults object and new exploitPatterns array format
    const exploitPatterns = treasure.exploitPatterns || vectorData?.exploitPatterns || [];
    const exploitMap = new Map(exploitPatterns.map(r => [r.pattern, r]));
    const reinitResult = exploitMap.get('reinitialization');
    const isReinitable = (reinitResult && reinitResult.detected) || hasCallableInit;

    // Check 5: Metamorphic — CREATE2 + SELFDESTRUCT, code can be replaced
    const metamorphicResult = exploitMap.get('metamorphic_create2');
    const isMetamorphic = (metamorphicResult && metamorphicResult.detected) ||
      (treasure.hasSelfdestruct || vectorData?.hasSelfdestruct);

    // Check 6: Staking contract with no position
    const hasStakingOnly = actions.some(a => STAKING_SELECTORS.has(a.selector));
    const hasNoRealExtraction = actions.every(a =>
      VIEW_SELECTORS.has(a.selector) || STAKING_SELECTORS.has(a.selector)
    );

    // Check 7: Dust trap — fake token balances
    const tokenBals = treasure.tokenBalances || {};
    let hasFakeTokens = false;
    for (const [, val] of Object.entries(tokenBals)) {
      const num = typeof val === 'string' ? parseFloat(val) : Number(val);
      if (num > FAKE_TOKEN_THRESHOLD) {
        hasFakeTokens = true;
        break;
      }
    }

    // Check 8: Dust — real but negligible ETH
    const isDust = ethBalance > 0 && ethBalance < DUST_THRESHOLD_ETH && !hasFakeTokens;

    // Priority ordering: locked > metamorphic > reinit > deployer_only > dust-trap > staking > dust > view-only
    // Locked funds are definitively unreachable.
    // Metamorphic/reinit are misclassified — they're vulnerability targets, not direct treasures.
    // Deployer-only means we can't extract (only deployer can).
    if (isLocked) return lockType;
    if (isMetamorphic) return 'metamorphic';
    if (isReinitable && !hasOwnerGatedExtraction) return 'reinit_vulnerable';
    if (isDeployerOwned && hasOwnerGatedExtraction && ethBalance > 0) return 'deployer_only';
    if (hasFakeTokens) return 'dust-trap';
    if (hasStakingOnly && hasNoRealExtraction && ethBalance > 0) return 'staking-no-position';
    if (isDust) return 'dust';
    if (allViewOnly) return 'view-only';

    return null; // Might be a genuine treasure
  }

  /**
   * Load optional enrichment data from analysis passes.
   * Returns Maps keyed by lowercase address.
   */
  loadEnrichmentData(exploitPath, storagePath, deployerPath) {
    const exploitMap = new Map();
    const storageMap = new Map();
    const deployerMap = new Map();

    if (exploitPath && fs.existsSync(exploitPath)) {
      const exploits = JSON.parse(fs.readFileSync(exploitPath, 'utf-8'));
      for (const e of (Array.isArray(exploits) ? exploits : [])) {
        const addr = (e.address || '').toLowerCase();
        if (addr) {
          const flags = { ...e.flags };
          for (const r of (e.results || [])) {
            if (r.detected) flags[r.pattern] = r;
          }
          exploitMap.set(addr, flags);
        }
      }
      log.info(`loaded exploit patterns for ${exploitMap.size} contracts`);
    }

    if (storagePath && fs.existsSync(storagePath)) {
      const storage = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      for (const c of (storage.contracts || [])) {
        const addr = (c.address || '').toLowerCase();
        if (addr) storageMap.set(addr, c);
      }
      log.info(`loaded storage analysis for ${storageMap.size} contracts`);
    }

    if (deployerPath && fs.existsSync(deployerPath)) {
      const deployers = JSON.parse(fs.readFileSync(deployerPath, 'utf-8'));
      const classifications = deployers.classifications || deployers.stats?.classifications || {};
      // Build a deployer->classification lookup from the raw data
      for (const [cls, addrs] of Object.entries(classifications)) {
        if (Array.isArray(addrs)) {
          for (const a of addrs) deployerMap.set(a.toLowerCase(), cls);
        }
      }
      // Also check topDeployersByCount
      for (const d of (deployers.stats?.topDeployersByCount || [])) {
        if (d.address) deployerMap.set(d.address.toLowerCase(), 'serial_deployer');
      }
      log.info(`loaded deployer classifications for ${deployerMap.size} addresses`);
    }

    return { exploitMap, storageMap, deployerMap };
  }

  /**
   * Process all vectors: read raw vectors, cross-reference treasure report,
   * apply corrected labels, write output.
   *
   * Optional enrichment: exploitPath, storagePath, deployerPath — JSON files
   * from previous analysis passes that provide deeper ground truth.
   */
  labelAll(vectorsPath, treasurePath, outputPath, opts = {}) {
    const treasureMap = this.loadTreasureReport(treasurePath);
    const { exploitMap, storageMap, deployerMap } = this.loadEnrichmentData(
      opts.exploitPath, opts.storagePath, opts.deployerPath
    );

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

      // Merge enrichment data into vector for classification
      const exploitData = exploitMap.get(addr) || {};
      const storageData = storageMap.get(addr) || {};
      const deployerClass = deployerMap.get((vector.deployer || '').toLowerCase());

      // Enrich vector with exploit/storage findings for classifyTreasure
      const enrichedVector = {
        ...vector,
        exploitResults: {
          reinitializable: !!exploitData.reinitialization?.detected,
          hasCreate2: !!exploitData.hasCreate2 || !!exploitData.metamorphic_create2?.detected,
          hasMetamorphic: !!exploitData.metamorphic_create2?.detected,
          hasDelegatecall: !!exploitData.hasDelegatecall,
        },
        storageOwner: storageData.likelyOwner || null,
        deployerClassification: deployerClass || null,
        hasSelfdestruct: vector.hasSelfdestruct || !!exploitData.hasSelfdestruct,
        selectors: vector.selectorHashes
          ? vector.selectorHashes.map(h => h.toString(16).padStart(8, '0'))
          : (vector.selectors || []),
      };

      // Check if this address was in the treasure report
      const treasure = treasureMap.get(addr);

      if (treasure) {
        const falsePositiveCategory = this.classifyTreasure(treasure, enrichedVector);

        if (falsePositiveCategory) {
          // Correct the label: this is NOT a treasure
          labels.treasure = false;
          labels.falsePositiveCategory = falsePositiveCategory;
          labels.originalTreasure = true; // Track that it was originally flagged

          // Also correct feature index 34 (treasure flag in the vector)
          if (vector.features && vector.features.length > 34) {
            vector.features[34] = 0;
          }

          this.stats.correctedFalsePositives++;
          if (this.stats.categories[falsePositiveCategory] !== undefined) {
            this.stats.categories[falsePositiveCategory]++;
          } else {
            this.stats.categories[falsePositiveCategory] = 1;
          }

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

      // Add enrichment labels for ALL contracts (not just treasures)
      // These provide deeper ground truth for the neural network
      labels.ownerType = this._classifyOwnerType(enrichedVector, storageData);
      labels.deployerType = deployerClass || 'unknown';
      labels.hasVulnerability = enrichedVector.exploitResults.reinitializable
        || enrichedVector.exploitResults.hasMetamorphic
        || (storageData.vulnerabilities && storageData.vulnerabilities.length > 0);
      labels.isMetamorphic = enrichedVector.exploitResults.hasMetamorphic;
      labels.isReinitializable = enrichedVector.exploitResults.reinitializable;

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

  /**
   * Classify owner type from enrichment data.
   * Returns: 'renounced', 'burned', 'deployer', 'third_party', 'none', 'unknown'
   */
  _classifyOwnerType(enrichedVector, storageData) {
    const owner = (storageData.likelyOwner || '').toLowerCase();
    if (!owner || owner === '0x') return 'unknown';

    if (RENOUNCED_ADDRESSES.has(owner)) return 'renounced';
    if (BURNED_ADDRESSES.has(owner)) return 'burned';

    const deployer = (enrichedVector.deployer || '').toLowerCase();
    if (owner && deployer && owner === deployer) return 'deployer';

    // Check if owner looks like a real address (not a uint256 misread)
    // Real addresses have the first 12 bytes as zero in a 32-byte slot
    if (owner.startsWith('0x') && owner.length === 42) {
      return 'third_party';
    }

    return 'unknown';
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

  const exploitPath = getArg('--exploits', path.join(dataDir, 'exploit-patterns-results.json'));
  const storagePath = getArg('--storage', path.join(dataDir, 'storage-slot-analysis.json'));
  const deployerPath = getArg('--deployers', path.join(dataDir, 'deployer-analysis.json'));

  log.info(`vectors:   ${vectorsPath}`);
  log.info(`treasures: ${treasurePath}`);
  log.info(`output:    ${outputPath}`);
  log.info(`exploits:  ${exploitPath}`);
  log.info(`storage:   ${storagePath}`);
  log.info(`deployers: ${deployerPath}`);

  const labeler = new Labeler();
  const stats = labeler.labelAll(vectorsPath, treasurePath, outputPath, {
    exploitPath,
    storagePath,
    deployerPath,
  });

  console.log('\n=== LABELING SUMMARY ===');
  console.log(JSON.stringify(stats, null, 2));
}

module.exports = {
  Labeler,
  VIEW_SELECTORS,
  DEAD_ADDRESSES,
  RENOUNCED_ADDRESSES,
  BURNED_ADDRESSES,
  STAKING_SELECTORS,
  INITIALIZER_SELECTORS,
};
