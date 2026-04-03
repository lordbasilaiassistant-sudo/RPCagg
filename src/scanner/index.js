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
  KNOWN_TOKENS,
  IMPL_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
  analyzeExploitPatterns,
  quickBytecodeFlags,
};
