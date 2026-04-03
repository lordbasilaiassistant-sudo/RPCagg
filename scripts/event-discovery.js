#!/usr/bin/env node
/**
 * Event-Based Contract Discovery
 *
 * Instead of scanning 44M blocks sequentially (getBlockByNumber x 44M),
 * this finds interesting contracts through targeted event log queries.
 *
 * One eth_getLogs call over 10K blocks replaces 10K getBlockByNumber calls.
 *
 * Event Sources:
 * 1. OwnershipTransferred(address(0), newOwner) — Ownable contract deployment
 * 2. Initialized(version) — proxy initialization (OpenZeppelin)
 * 3. Upgraded(implementation) — proxy upgrades (EIP-1967)
 * 4. PairCreated — Uniswap V2/V3 and Aerodrome DEX pair creation
 * 5. PoolCreated — Uniswap V3 / Aerodrome CL pools
 *
 * Usage: node scripts/event-discovery.js [startBlock] [endBlock] [--chunk-size=10000]
 */

const fs = require('fs');
const path = require('path');
const { RpcClient } = require('../src/scanner');
const { makeLogger, setLevel } = require('../src/logger');

const log = makeLogger('event-discovery');
setLevel(process.env.LOG_LEVEL || 'info');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA_DIR = path.join(__dirname, '..', 'data');

// --- Event Signatures (topic0) ---
const EVENTS = {
  // OwnershipTransferred(address indexed previousOwner, address indexed newOwner)
  OWNERSHIP_TRANSFERRED: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',

  // Initialized(uint8 version) — OpenZeppelin Initializable
  INITIALIZED: '0x7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb3847402498',

  // Upgraded(address indexed implementation) — EIP-1967
  UPGRADED: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',

  // AdminChanged(address previousAdmin, address newAdmin) — EIP-1967
  ADMIN_CHANGED: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f',

  // BeaconUpgraded(address indexed beacon) — EIP-1967
  BEACON_UPGRADED: '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e',

  // PairCreated(address indexed token0, address indexed token1, address pair, uint) — UniV2
  PAIR_CREATED: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',

  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) — UniV3
  POOL_CREATED: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
};

// Known factory addresses on Base
const FACTORIES = {
  // Uniswap V2 (BaseSwap)
  UNISWAP_V2: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
  // Aerodrome V2
  AERODROME_V2: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  // Uniswap V3
  UNISWAP_V3: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  // Aerodrome CL (Slipstream)
  AERODROME_CL: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class EventDiscovery {
  constructor() {
    this.rpc = new RpcClient(RPC);
    this.discovered = {
      ownableContracts: [],     // Contracts with OwnershipTransferred from 0x0
      initializedProxies: [],   // Proxy initializations
      upgradedProxies: [],      // Proxy upgrades
      dexPairs: [],             // DEX liquidity pairs
      dexPools: [],             // DEX V3/CL pools
    };
    this.stats = { totalLogs: 0, totalCalls: 0, blocksScanned: 0 };
  }

  async run(startBlock, endBlock, chunkSize = 10000) {
    log.info(`Event discovery: blocks ${startBlock} - ${endBlock} (chunk size: ${chunkSize})`);

    const totalBlocks = endBlock - startBlock;
    const totalChunks = Math.ceil(totalBlocks / chunkSize);
    log.info(`${totalBlocks} blocks in ${totalChunks} chunks`);

    for (let from = startBlock; from <= endBlock; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, endBlock);
      const fromHex = '0x' + from.toString(16);
      const toHex = '0x' + to.toString(16);
      const chunkNum = Math.floor((from - startBlock) / chunkSize) + 1;

      log.info(`chunk ${chunkNum}/${totalChunks}: blocks ${from}-${to}`);

      // Run all event queries in parallel for this chunk
      const [ownable, initialized, upgraded, pairs, pools] = await Promise.all([
        this._queryLogs(fromHex, toHex, EVENTS.OWNERSHIP_TRANSFERRED, 'ownable'),
        this._queryLogs(fromHex, toHex, EVENTS.INITIALIZED, 'initialized'),
        this._queryLogs(fromHex, toHex, EVENTS.UPGRADED, 'upgraded'),
        this._queryPairCreated(fromHex, toHex),
        this._queryPoolCreated(fromHex, toHex),
      ]);

      // Process OwnershipTransferred events
      for (const entry of ownable) {
        // topic[1] = previousOwner, topic[2] = newOwner
        // If previousOwner is 0x0, this is a deployment/initialization
        if (entry.topics[1] === '0x' + '0'.repeat(64)) {
          const newOwner = '0x' + (entry.topics[2] || '').slice(-40);
          this.discovered.ownableContracts.push({
            contract: entry.address,
            owner: newOwner,
            blockNumber: parseInt(entry.blockNumber, 16),
            txHash: entry.transactionHash,
          });
        }
      }

      // Process Initialized events
      for (const entry of initialized) {
        const version = entry.data ? parseInt(entry.data, 16) : 0;
        this.discovered.initializedProxies.push({
          contract: entry.address,
          version,
          blockNumber: parseInt(entry.blockNumber, 16),
          txHash: entry.transactionHash,
        });
      }

      // Process Upgraded events
      for (const entry of upgraded) {
        const implementation = '0x' + (entry.topics[1] || '').slice(-40);
        this.discovered.upgradedProxies.push({
          contract: entry.address,
          implementation,
          blockNumber: parseInt(entry.blockNumber, 16),
          txHash: entry.transactionHash,
        });
      }

      // Process PairCreated events
      for (const entry of pairs) {
        const token0 = '0x' + (entry.topics[1] || '').slice(-40);
        const token1 = '0x' + (entry.topics[2] || '').slice(-40);
        // pair address is first 32 bytes of data
        const pair = entry.data ? '0x' + entry.data.slice(26, 66) : null;
        this.discovered.dexPairs.push({
          factory: entry.address,
          token0,
          token1,
          pair,
          blockNumber: parseInt(entry.blockNumber, 16),
          txHash: entry.transactionHash,
        });
      }

      // Process PoolCreated events
      for (const entry of pools) {
        const token0 = '0x' + (entry.topics[1] || '').slice(-40);
        const token1 = '0x' + (entry.topics[2] || '').slice(-40);
        const fee = entry.topics[3] ? parseInt(entry.topics[3], 16) : 0;
        // pool address is in data (after tickSpacing)
        let pool = null;
        if (entry.data && entry.data.length >= 130) {
          pool = '0x' + entry.data.slice(90, 130);
        }
        this.discovered.dexPools.push({
          factory: entry.address,
          token0,
          token1,
          fee,
          pool,
          blockNumber: parseInt(entry.blockNumber, 16),
          txHash: entry.transactionHash,
        });
      }

      this.stats.blocksScanned += (to - from + 1);
    }

    this._writeResults(startBlock, endBlock);
    return this.discovered;
  }

  async _queryLogs(fromBlock, toBlock, topic0, label) {
    try {
      this.stats.totalCalls++;
      const result = await this.rpc.call('eth_getLogs', [{
        fromBlock,
        toBlock,
        topics: [topic0],
      }]);
      const logs = result || [];
      this.stats.totalLogs += logs.length;
      log.debug(`  ${label}: ${logs.length} events`);
      return logs;
    } catch (err) {
      // Some free RPCs reject address-less log queries. Retry with smaller chunks.
      if (err.message && err.message.includes('specify an address')) {
        log.debug(`  ${label}: provider requires address filter, splitting into sub-chunks`);
        return this._queryLogsChunked(fromBlock, toBlock, topic0, label);
      }
      log.warn(`  ${label} query failed: ${err.message}`);
      return [];
    }
  }

  async _queryLogsChunked(fromBlock, toBlock, topic0, label) {
    // Split into 2000-block sub-chunks for providers with stricter limits
    const from = parseInt(fromBlock, 16);
    const to = parseInt(toBlock, 16);
    const SUB_CHUNK = 2000;
    const allLogs = [];

    for (let start = from; start <= to; start += SUB_CHUNK) {
      const end = Math.min(start + SUB_CHUNK - 1, to);
      try {
        this.stats.totalCalls++;
        const result = await this.rpc.call('eth_getLogs', [{
          fromBlock: '0x' + start.toString(16),
          toBlock: '0x' + end.toString(16),
          topics: [topic0],
        }]);
        if (result) {
          allLogs.push(...result);
          this.stats.totalLogs += result.length;
        }
      } catch (subErr) {
        log.debug(`  ${label} sub-chunk ${start}-${end} failed: ${subErr.message}`);
      }
    }

    log.debug(`  ${label} (chunked): ${allLogs.length} events`);
    return allLogs;
  }

  async _queryPairCreated(fromBlock, toBlock) {
    const allPairs = [];
    for (const [name, addr] of Object.entries(FACTORIES)) {
      if (name.includes('CL')) continue; // CL factories use PoolCreated
      try {
        this.stats.totalCalls++;
        const result = await this.rpc.call('eth_getLogs', [{
          fromBlock,
          toBlock,
          address: addr,
          topics: [EVENTS.PAIR_CREATED],
        }]);
        if (result && result.length > 0) {
          allPairs.push(...result);
          this.stats.totalLogs += result.length;
        }
      } catch (err) {
        log.debug(`  PairCreated from ${name} failed: ${err.message}`);
      }
    }
    return allPairs;
  }

  async _queryPoolCreated(fromBlock, toBlock) {
    const allPools = [];
    for (const [name, addr] of Object.entries(FACTORIES)) {
      try {
        this.stats.totalCalls++;
        const result = await this.rpc.call('eth_getLogs', [{
          fromBlock,
          toBlock,
          address: addr,
          topics: [EVENTS.POOL_CREATED],
        }]);
        if (result && result.length > 0) {
          allPools.push(...result);
          this.stats.totalLogs += result.length;
        }
      } catch (err) {
        log.debug(`  PoolCreated from ${name} failed: ${err.message}`);
      }
    }
    return allPools;
  }

  _writeResults(startBlock, endBlock) {
    // Deduplicate contracts
    const allContracts = new Set();
    for (const c of this.discovered.ownableContracts) allContracts.add(c.contract.toLowerCase());
    for (const c of this.discovered.initializedProxies) allContracts.add(c.contract.toLowerCase());
    for (const c of this.discovered.upgradedProxies) allContracts.add(c.contract.toLowerCase());
    for (const c of this.discovered.dexPairs) { if (c.pair) allContracts.add(c.pair.toLowerCase()); }
    for (const c of this.discovered.dexPools) { if (c.pool) allContracts.add(c.pool.toLowerCase()); }

    const report = {
      discovery: {
        method: 'event-based',
        startBlock,
        endBlock,
        blocksScanned: this.stats.blocksScanned,
        rpcCallsMade: this.stats.totalCalls,
        totalEventsFound: this.stats.totalLogs,
        uniqueContractsDiscovered: allContracts.size,
        discoveredAt: new Date().toISOString(),
      },
      breakdown: {
        ownableContracts: this.discovered.ownableContracts.length,
        initializedProxies: this.discovered.initializedProxies.length,
        upgradedProxies: this.discovered.upgradedProxies.length,
        dexPairs: this.discovered.dexPairs.length,
        dexPools: this.discovered.dexPools.length,
      },
      efficiency: {
        blocksPerRpcCall: Math.round(this.stats.blocksScanned / Math.max(this.stats.totalCalls, 1)),
        eventsPerRpcCall: (this.stats.totalLogs / Math.max(this.stats.totalCalls, 1)).toFixed(1),
        note: 'Block scanner would need ' + this.stats.blocksScanned + ' RPC calls. Event discovery used ' + this.stats.totalCalls + '. Speedup: ' + Math.round(this.stats.blocksScanned / Math.max(this.stats.totalCalls, 1)) + 'x',
      },
      // Write unique contract list for downstream scanner
      contracts: [...allContracts],
      // Full event data
      events: this.discovered,
    };

    const outFile = path.join(DATA_DIR, `event-discovery-${startBlock}-${endBlock}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    log.info(`results written to ${outFile}`);

    // Also write a flat address list for piping into other tools
    const addrFile = path.join(DATA_DIR, `discovered-contracts-${startBlock}-${endBlock}.txt`);
    fs.writeFileSync(addrFile, [...allContracts].join('\n') + '\n');
    log.info(`address list written to ${addrFile}`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('  EVENT-BASED DISCOVERY REPORT');
    console.log('='.repeat(60));
    console.log(`  Range: blocks ${startBlock} - ${endBlock} (${this.stats.blocksScanned} blocks)`);
    console.log(`  RPC calls made: ${this.stats.totalCalls}`);
    console.log(`  Total events found: ${this.stats.totalLogs}`);
    console.log(`  Unique contracts discovered: ${allContracts.size}`);
    console.log('');
    console.log('  Breakdown:');
    console.log(`    Ownable contracts (new deployments): ${this.discovered.ownableContracts.length}`);
    console.log(`    Initialized proxies: ${this.discovered.initializedProxies.length}`);
    console.log(`    Upgraded proxies: ${this.discovered.upgradedProxies.length}`);
    console.log(`    DEX pairs (V2): ${this.discovered.dexPairs.length}`);
    console.log(`    DEX pools (V3/CL): ${this.discovered.dexPools.length}`);
    console.log('');
    console.log(`  Efficiency: ${Math.round(this.stats.blocksScanned / Math.max(this.stats.totalCalls, 1))}x fewer RPC calls than block scanning`);
    console.log('='.repeat(60));
  }
}

// --- Main ---
async function main() {
  const discovery = new EventDiscovery();

  // Check aggregator
  try {
    const health = await discovery.rpc.call('eth_blockNumber');
    log.info(`aggregator connected, chain head: ${parseInt(health, 16)}`);
  } catch (err) {
    console.error('Aggregator not running. Start with: node index.js');
    process.exit(1);
  }

  // Parse args
  const args = process.argv.slice(2);
  let startBlock = 1950000;
  let endBlock = 2050000;
  let chunkSize = 10000;

  for (const arg of args) {
    if (arg.startsWith('--chunk-size=')) {
      chunkSize = parseInt(arg.split('=')[1], 10);
    } else if (!isNaN(parseInt(arg, 10))) {
      if (startBlock === 1950000 && !args[0]?.startsWith('--')) startBlock = parseInt(arg, 10);
      else endBlock = parseInt(arg, 10);
    }
  }
  // Handle positional args properly
  const positional = args.filter(a => !a.startsWith('--'));
  if (positional.length >= 1) startBlock = parseInt(positional[0], 10);
  if (positional.length >= 2) endBlock = parseInt(positional[1], 10);

  await discovery.run(startBlock, endBlock, chunkSize);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
