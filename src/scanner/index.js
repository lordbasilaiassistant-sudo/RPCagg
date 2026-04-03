/**
 * Scanner module exports — clean public API.
 */

const { RpcClient, RpcError } = require('./rpc-client');
const { Checkpoint } = require('./checkpoint');
const { BaseScanner } = require('./base-scanner');
const { BlockScanner } = require('./block-scanner');
const { ContractScanner, IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT } = require('./contract-scanner');
const { Executor } = require('./executor');
const { EntropyScorer } = require('./entropy-scorer');
const { BlockPrioritizer } = require('./block-prioritizer');
const { analyzeExploitPatterns, quickBytecodeFlags } = require('./exploit-patterns');
const { TokenDiscovery, KNOWN_TOKENS } = require('./token-discovery');
const { DexPricer, FACTORIES: DEX_FACTORIES, WETH, STABLES } = require('./dex-pricer');
const { BytecodeSimilarity, extractOpcodes, computeNgrams, jaccardSimilarity } = require('./bytecode-similarity');

module.exports = {
  RpcClient,
  RpcError,
  Checkpoint,
  BaseScanner,
  BlockScanner,
  ContractScanner,
  Executor,
  EntropyScorer,
  BlockPrioritizer,
  TokenDiscovery,
  DexPricer,
  BytecodeSimilarity,
  KNOWN_TOKENS,
  DEX_FACTORIES,
  WETH,
  STABLES,
  IMPL_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
  analyzeExploitPatterns,
  quickBytecodeFlags,
  extractOpcodes,
  computeNgrams,
  jaccardSimilarity,
};
