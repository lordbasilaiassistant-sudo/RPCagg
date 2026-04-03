/**
 * Scanner module exports — clean public API.
 */

const { RpcClient, RpcError } = require('./rpc-client');
const { Checkpoint } = require('./checkpoint');
const { BaseScanner } = require('./base-scanner');
const { BlockScanner } = require('./block-scanner');
const { ContractScanner, IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT } = require('./contract-scanner');

module.exports = {
  RpcClient,
  RpcError,
  Checkpoint,
  BaseScanner,
  BlockScanner,
  ContractScanner,
  IMPL_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
};
