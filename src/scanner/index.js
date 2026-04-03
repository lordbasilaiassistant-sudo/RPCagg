/**
 * Scanner module exports — clean public API.
 */

const { RpcClient, RpcError } = require('./rpc-client');
const { Checkpoint } = require('./checkpoint');
const { BaseScanner } = require('./base-scanner');
const { BlockScanner } = require('./block-scanner');
const { ContractScanner, IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT } = require('./contract-scanner');
const { Executor } = require('./executor');

module.exports = {
  RpcClient,
  RpcError,
  Checkpoint,
  BaseScanner,
  BlockScanner,
  ContractScanner,
  Executor,
  IMPL_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
};
