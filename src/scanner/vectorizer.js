/**
 * Vectorizer — compresses contract analysis into fixed-size feature vectors
 * for neural network training.
 *
 * FEATURE_SCHEMA is the single source of truth for all feature dimensions.
 * Every consumer (model.py, labeler.js, revectorize.js, scorer.js) reads
 * FEATURE_SCHEMA.length for input_dim instead of hardcoding a number.
 *
 * Output: JSONL where first line is { _schema: version, dim: N }
 * and remaining lines are { address, features: number[], labels: {} }
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../logger');
const log = makeLogger('vectorizer');

// =========================================================================
// FEATURE_SCHEMA — the authoritative registry.
// Every feature has: index, name, group, type.
//   type: 'binary' (0 or 1), 'normalized' (0-1 continuous), 'encoded' (categorical float)
//   group: used by model.py for FeatureGroupEncoder slicing
//
// To add a new feature: append to this array, bump SCHEMA_VERSION.
// The model reads FEATURE_SCHEMA.length — no hardcoded dims anywhere.
// =========================================================================

const SCHEMA_VERSION = '3.0.0'; // 1.0=35-dim, 2.0=38-dim, 3.0=50-dim

const FEATURE_SCHEMA = [
  // --- structural (0-9) ---
  { index: 0,  name: 'code_size',             group: 'structural',       type: 'normalized' },
  { index: 1,  name: 'destroyed',             group: 'structural',       type: 'binary' },
  { index: 2,  name: 'is_proxy',              group: 'structural',       type: 'binary' },
  { index: 3,  name: 'proxy_type',            group: 'structural',       type: 'encoded' },
  { index: 4,  name: 'is_factory',            group: 'structural',       type: 'binary' },
  { index: 5,  name: 'has_selfdestruct',      group: 'structural',       type: 'binary' },
  { index: 6,  name: 'selector_count',        group: 'structural',       type: 'normalized' },
  { index: 7,  name: 'extraction_fn_count',   group: 'structural',       type: 'normalized' },
  { index: 8,  name: 'deploy_gas',            group: 'structural',       type: 'normalized' },
  { index: 9,  name: 'deploy_block',          group: 'structural',       type: 'normalized' },
  // --- financial (10-16) ---
  { index: 10, name: 'eth_balance',           group: 'financial',        type: 'normalized' },
  { index: 11, name: 'has_eth',               group: 'financial',        type: 'binary' },
  { index: 12, name: 'weth_balance',          group: 'financial',        type: 'normalized' },
  { index: 13, name: 'usdc_balance',          group: 'financial',        type: 'normalized' },
  { index: 14, name: 'usdbc_balance',         group: 'financial',        type: 'normalized' },
  { index: 15, name: 'dai_balance',           group: 'financial',        type: 'normalized' },
  { index: 16, name: 'has_tokens',            group: 'financial',        type: 'binary' },
  // --- capability (17-30) — one per SELECTOR_CATEGORIES entry ---
  { index: 17, name: 'cap_transfer',          group: 'capability',       type: 'normalized' },
  { index: 18, name: 'cap_withdraw',          group: 'capability',       type: 'normalized' },
  { index: 19, name: 'cap_deposit',           group: 'capability',       type: 'normalized' },
  { index: 20, name: 'cap_swap',              group: 'capability',       type: 'normalized' },
  { index: 21, name: 'cap_liquidity',         group: 'capability',       type: 'normalized' },
  { index: 22, name: 'cap_governance',        group: 'capability',       type: 'normalized' },
  { index: 23, name: 'cap_admin',             group: 'capability',       type: 'normalized' },
  { index: 24, name: 'cap_emergency',         group: 'capability',       type: 'normalized' },
  { index: 25, name: 'cap_upgrade',           group: 'capability',       type: 'normalized' },
  { index: 26, name: 'cap_sweep',             group: 'capability',       type: 'normalized' },
  { index: 27, name: 'cap_mint',              group: 'capability',       type: 'normalized' },
  { index: 28, name: 'cap_burn',              group: 'capability',       type: 'normalized' },
  { index: 29, name: 'cap_pause',             group: 'capability',       type: 'normalized' },
  { index: 30, name: 'cap_claim',             group: 'capability',       type: 'normalized' },
  // --- extraction (31-34) ---
  { index: 31, name: 'sim_success_rate',      group: 'extraction',       type: 'normalized' },
  { index: 32, name: 'extraction_success_rate', group: 'extraction',     type: 'normalized' },
  { index: 33, name: 'successful_sims',       group: 'extraction',       type: 'normalized' },
  { index: 34, name: 'labeled_treasure',      group: 'extraction',       type: 'binary' },
  // --- transfer_verification (35-37) ---
  { index: 35, name: 'flat_gas_fraction',     group: 'transfer_verif',   type: 'normalized' },
  { index: 36, name: 'withdraw_reverts',      group: 'transfer_verif',   type: 'binary' },
  { index: 37, name: 'caller_balance',        group: 'transfer_verif',   type: 'normalized' },
  // --- exploit (38-45) — one per analyzeExploitPatterns() detector ---
  { index: 38, name: 'reinitializable',       group: 'exploit',          type: 'binary' },
  { index: 39, name: 'metamorphic',           group: 'exploit',          type: 'binary' },
  { index: 40, name: 'admin_collision',       group: 'exploit',          type: 'binary' },
  { index: 41, name: 'delegatecall_vuln',     group: 'exploit',          type: 'binary' },
  { index: 42, name: 'unchecked_return',      group: 'exploit',          type: 'binary' },
  { index: 43, name: 'txorigin_auth',         group: 'exploit',          type: 'binary' },
  { index: 44, name: 'unprotected_owner',     group: 'exploit',          type: 'binary' },
  { index: 45, name: 'abandoned_timelock',    group: 'exploit',          type: 'binary' },
  // --- ownership (46-49) ---
  { index: 46, name: 'owner_is_zero',         group: 'ownership',        type: 'binary' },
  { index: 47, name: 'owner_is_dead',         group: 'ownership',        type: 'binary' },
  { index: 48, name: 'owner_is_deployer',     group: 'ownership',        type: 'binary' },
  { index: 49, name: 'deployer_is_dormant',   group: 'ownership',        type: 'binary' },
];

// Derived constants from schema — computed once, used everywhere.
const FEATURE_DIM = FEATURE_SCHEMA.length;
const BINARY_INDICES = FEATURE_SCHEMA.filter(f => f.type === 'binary').map(f => f.index);
const FEATURE_GROUPS = {};
for (const f of FEATURE_SCHEMA) {
  if (!FEATURE_GROUPS[f.group]) FEATURE_GROUPS[f.group] = { start: f.index, end: f.index + 1 };
  else FEATURE_GROUPS[f.group].end = f.index + 1;
}

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

// Dead/zero addresses for ownership classification
const DEAD_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
]);

// Pattern names from analyzeExploitPatterns() — order matches exploit features [38-45].
const EXPLOIT_PATTERN_ORDER = [
  'reinitialization',
  'metamorphic_create2',
  'admin_slot_collision',
  'delegatecall_user_target',
  'unchecked_return',
  'tx_origin_auth',
  'unprotected_owner',
  'abandoned_timelock',
];

class Vectorizer {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.vectors = [];
  }

  // Convert a contract analysis object into a feature vector
  vectorize(contract) {
    const features = [];

    // --- Structural features (0-9) ---
    features.push(normalize(contract.codeSize || 0, 0, 50000));
    features.push(contract.destroyed ? 1 : 0);
    features.push(contract.isProxy ? 1 : 0);
    features.push(encodeProxyType(contract.proxyType));
    features.push(contract.isFactory ? 1 : 0);
    features.push(contract.hasSelfdestruct ? 1 : 0);
    features.push(normalize(contract.selectors?.length || 0, 0, 200));
    features.push(normalize(contract.extractionFunctions?.length || 0, 0, 20));
    features.push(normalize(contract.gasUsed || 0, 0, 30000000));
    features.push(normalize(contract.blockNumber || 0, 0, 50000000));

    // --- Financial features (10-16) ---
    const ethBal = contract.ethBalance ? Number(contract.ethBalance) / 1e18 : 0;
    features.push(logNormalize(ethBal));
    features.push(ethBal > 0 ? 1 : 0);
    const tokenBals = contract.tokenBalances || {};
    features.push(logNormalize(Number(tokenBals.WETH || 0) / 1e18));
    features.push(logNormalize(Number(tokenBals.USDC || 0) / 1e6));
    features.push(logNormalize(Number(tokenBals.USDbC || 0) / 1e6));
    features.push(logNormalize(Number(tokenBals.DAI || 0) / 1e18));
    features.push(Object.keys(tokenBals).length > 0 ? 1 : 0);

    // --- Capability fingerprint (17-30) ---
    const sels = new Set(contract.selectors || []);
    for (const [, catSels] of Object.entries(SELECTOR_CATEGORIES)) {
      const matches = catSels.filter(s => sels.has(s)).length;
      features.push(matches / catSels.length);
    }

    // --- Extraction sim features (31-34) ---
    const sims = contract.simResults || [];
    const simTotal = sims.length;
    const simSuccess = sims.filter(s => s.success).length;
    const simExtraction = sims.filter(s => s.success && SELECTOR_CATEGORIES.withdraw?.includes(s.selector)).length;
    features.push(simTotal > 0 ? simSuccess / simTotal : 0);
    features.push(simTotal > 0 ? simExtraction / simTotal : 0);
    features.push(normalize(simSuccess, 0, 50));
    features.push(contract.treasure ? 1 : 0);

    // --- Transfer verification features (35-37) ---
    const gasEstimates = contract.gasEstimates || [];
    const flatGasCount = gasEstimates.filter(g => g <= 26000).length;
    features.push(gasEstimates.length > 0 ? flatGasCount / gasEstimates.length : 0);
    features.push(contract.withdrawRevertsForCaller ? 1 : 0);
    features.push(logNormalize(contract.callerBalanceInContract || 0));

    // --- Exploit pattern features (38-45) ---
    const exploitResults = contract.exploitPatterns || [];
    const exploitMap = new Map(exploitResults.map(r => [r.pattern, r]));
    for (const patternName of EXPLOIT_PATTERN_ORDER) {
      const r = exploitMap.get(patternName);
      features.push(r && r.detected ? 1 : 0);
    }

    // --- Ownership status features (46-49) ---
    const owner = (contract.owner || '').toLowerCase();
    const deployer = (contract.deployer || '').toLowerCase();
    features.push(owner === '0x' + '0'.repeat(40) ? 1 : 0);
    features.push(DEAD_ADDRESSES.has(owner) && owner !== '0x' + '0'.repeat(40) ? 1 : 0);
    features.push(owner && deployer && owner === deployer ? 1 : 0);
    features.push(contract.deployerDormant ? 1 : 0);

    // --- Validate dimension matches schema ---
    if (features.length !== FEATURE_DIM) {
      throw new Error(`Vectorizer produced ${features.length} features but FEATURE_SCHEMA expects ${FEATURE_DIM}. Schema is out of sync.`);
    }

    // Labels (for supervised training)
    const exploitDetected = exploitResults.some(r => r.detected);
    const maxSeverity = exploitResults.reduce((worst, r) => {
      if (!r.detected) return worst;
      const rank = { critical: 4, high: 3, medium: 2, low: 1 };
      return (rank[r.severity] || 0) > (rank[worst] || 0) ? r.severity : worst;
    }, 'none');

    const labels = {
      hasValue: ethBal > 0 || Object.keys(tokenBals).length > 0,
      hasCallableExtraction: simExtraction > 0,
      treasure: contract.treasure || false,
      ethValue: ethBal,
      proxyType: contract.proxyType || 'none',
      ownershipStatus: classifyOwnership(owner, deployer),
      exploitDetected,
      maxExploitSeverity: maxSeverity,
      deployerDormant: !!contract.deployerDormant,
    };

    // Raw selector hashes for learned embedding (bag-of-selectors input).
    const selectorHashes = (contract.selectors || []).map(s => parseInt(s, 16));

    const vector = {
      address: contract.address,
      deployer: contract.deployer,
      block: contract.blockNumber,
      features,
      selectorHashes,
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

  // Write vectors to JSONL file — first line is schema header
  write(filename = 'vectors.jsonl') {
    const filePath = path.join(this.outputDir, filename);
    const stream = fs.createWriteStream(filePath);

    // Schema header — lets readers verify compatibility
    stream.write(JSON.stringify({
      _schema: SCHEMA_VERSION,
      dim: FEATURE_DIM,
      features: FEATURE_SCHEMA.map(f => f.name),
      groups: FEATURE_GROUPS,
    }) + '\n');

    for (const v of this.vectors) {
      stream.write(JSON.stringify(v) + '\n');
    }

    stream.end();
    log.info(`wrote ${this.vectors.length} vectors to ${filePath} (schema=${SCHEMA_VERSION}, dim=${FEATURE_DIM})`);
    return filePath;
  }

  // Get stats about the dataset
  getStats() {
    const withValue = this.vectors.filter(v => v.labels.hasValue).length;
    const withExtraction = this.vectors.filter(v => v.labels.hasCallableExtraction).length;
    const treasures = this.vectors.filter(v => v.labels.treasure).length;

    return {
      totalVectors: this.vectors.length,
      dimensions: FEATURE_DIM,
      schemaVersion: SCHEMA_VERSION,
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

// Log normalize for financial values (handles extreme range).
// Divisor=6 maps the practical range [0, 1M] to [0, 1] with good separation
// in the critical 1-1000 ETH band.
function logNormalize(val) {
  if (val <= 0) return 0;
  return Math.min(1, Math.log10(val + 1) / 6);
}

// Encode proxy type as a float
function encodeProxyType(type) {
  const types = { 'eip1167-minimal': 0.1, 'eip1967': 0.2, 'transparent': 0.3, 'uups': 0.4, 'beacon': 0.5, 'diamond-eip2535': 0.6, 'delegatecall': 0.7 };
  return types[type] || 0;
}

// Classify ownership status for enriched labels
function classifyOwnership(owner, deployer) {
  if (!owner || owner === '0x' + '0'.repeat(40)) return 'renounced';
  if (DEAD_ADDRESSES.has(owner)) return 'burned';
  if (owner && deployer && owner === deployer) return 'deployer_owned';
  return 'other';
}

module.exports = {
  Vectorizer,
  FEATURE_SCHEMA,
  FEATURE_DIM,
  FEATURE_GROUPS,
  BINARY_INDICES,
  SCHEMA_VERSION,
  SELECTOR_CATEGORIES,
  DEAD_ADDRESSES,
};
