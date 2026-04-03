#!/usr/bin/env node
/**
 * Sweet Spot Analyzer — Phase 2 Pipeline
 *
 * Takes discovered contracts from event-discovery (blocks 10M-35M),
 * batch-checks ETH balances via Multicall3, filters funded contracts,
 * then runs TokenDiscovery + DexPricer to value all holdings.
 *
 * Designed for 100K+ contracts. Uses:
 * - Multicall3 for batching (200 balance checks per call)
 * - Streaming progress with checkpointing
 * - RpcClient with built-in backpressure handling
 *
 * Usage:
 *   node scripts/analyze-sweet-spot.js [input-file] [--resume]
 *
 * Default input: data/discovered-contracts-10000000-35000000.txt
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, TokenDiscovery, DexPricer } = require('../src/scanner');

// --- Config ---
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BALANCE_BATCH_SIZE = 200;        // 200 balance checks per Multicall3 call
const TOKEN_DISCOVERY_CONCURRENCY = 5; // parallel token discovery jobs
const MIN_ETH_BALANCE = 0.001;         // filter threshold in ETH
const CHECKPOINT_INTERVAL = 1000;      // save checkpoint every N contracts
const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'discovered-contracts-10000000-35000000.txt');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'sweet-spot-funded.json');
const CHECKPOINT_FILE = path.join(__dirname, '..', 'data', '.sweet-spot-checkpoint.json');

// Multicall3 selectors
const AGGREGATE3_SEL = '82ad56cb';
// ETH balance via getEthBalance(address) on Multicall3 itself
const GET_ETH_BALANCE_SEL = '4d2301cc';

// --- Multicall3 encoding (reused pattern) ---

function encodeMulticall3(calls) {
  let encoded = AGGREGATE3_SEL;
  encoded += '0000000000000000000000000000000000000000000000000000000000000020';
  encoded += BigInt(calls.length).toString(16).padStart(64, '0');

  const elemOffsets = [];
  let currentOffset = calls.length * 32;
  for (const call of calls) {
    elemOffsets.push(currentOffset);
    const dataLen = (call.callData.replace('0x', '').length / 2);
    const paddedLen = Math.ceil(dataLen / 32) * 32;
    currentOffset += 32 + 32 + 32 + 32 + paddedLen;
  }

  for (const offset of elemOffsets) {
    encoded += BigInt(offset).toString(16).padStart(64, '0');
  }

  for (const call of calls) {
    encoded += call.target.toLowerCase().replace('0x', '').padStart(64, '0');
    encoded += call.allowFailure
      ? '0000000000000000000000000000000000000000000000000000000000000001'
      : '0000000000000000000000000000000000000000000000000000000000000000';
    encoded += '0000000000000000000000000000000000000000000000000000000000000060';
    const data = call.callData.replace('0x', '');
    const dataLen = data.length / 2;
    encoded += BigInt(dataLen).toString(16).padStart(64, '0');
    const paddedLen = Math.ceil(dataLen / 32) * 32;
    encoded += data.padEnd(paddedLen * 2, '0');
  }

  return '0x' + encoded;
}

function decodeMulticall3Result(result, count) {
  const hex = result.replace('0x', '');
  const decoded = [];
  let pos = 128;

  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(parseInt(hex.substring(pos, pos + 64), 16) * 2);
    pos += 64;
  }

  for (let i = 0; i < count; i++) {
    const base = 64 + offsets[i];
    const success = parseInt(hex.substring(base, base + 64), 16) === 1;
    const dataOffset = parseInt(hex.substring(base + 64, base + 128), 16) * 2;
    const dataStart = base + dataOffset;
    const dataLen = parseInt(hex.substring(dataStart, dataStart + 64), 16);
    const data = '0x' + hex.substring(dataStart + 64, dataStart + 64 + dataLen * 2);
    decoded.push({ success, data });
  }

  return decoded;
}

// --- Phase 1: Batch ETH Balance Check ---
// Uses JSON-RPC batch eth_getBalance through the aggregator's batch support.
// RpcClient.batchChunked handles chunking and error handling.

async function batchCheckBalances(rpc, addresses) {
  const balances = new Map();
  const total = addresses.length;
  let processed = 0;
  let funded = 0;

  console.log(`\n[Phase 1] Checking ETH balances for ${total.toLocaleString()} contracts...`);
  console.log(`  Batch size: ${BALANCE_BATCH_SIZE} via JSON-RPC batch`);
  console.log(`  Min balance: ${MIN_ETH_BALANCE} ETH\n`);

  for (let i = 0; i < addresses.length; i += BALANCE_BATCH_SIZE) {
    const batch = addresses.slice(i, i + BALANCE_BATCH_SIZE);

    const calls = batch.map(addr => ({
      method: 'eth_getBalance',
      params: [addr, 'latest'],
    }));

    try {
      const results = await rpc.batchChunked(calls, 50);

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r && typeof r === 'string' && r !== '0x0') {
          try {
            const wei = BigInt(r);
            const eth = Number(wei) / 1e18;
            if (eth >= MIN_ETH_BALANCE) {
              balances.set(batch[j].toLowerCase(), { wei: wei.toString(), eth });
              funded++;
            }
          } catch { /* skip malformed */ }
        } else if (r && r.result && typeof r.result === 'string') {
          try {
            const wei = BigInt(r.result);
            const eth = Number(wei) / 1e18;
            if (eth >= MIN_ETH_BALANCE) {
              balances.set(batch[j].toLowerCase(), { wei: wei.toString(), eth });
              funded++;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error(`  WARNING: batch at offset ${i} failed: ${err.message}, trying individually...`);
      for (const addr of batch) {
        try {
          const r = await rpc.call('eth_getBalance', [addr, 'latest']);
          const wei = BigInt(r);
          const eth = Number(wei) / 1e18;
          if (eth >= MIN_ETH_BALANCE) {
            balances.set(addr.toLowerCase(), { wei: wei.toString(), eth });
            funded++;
          }
        } catch { /* skip */ }
      }
    }

    processed += batch.length;
    if (processed % 5000 === 0 || processed >= total) {
      const pct = ((processed / total) * 100).toFixed(1);
      console.log(`  ${processed.toLocaleString()}/${total.toLocaleString()} checked (${pct}%) — ${funded} funded so far`);
    }
  }

  console.log(`\n[Phase 1] Complete: ${funded} contracts with >= ${MIN_ETH_BALANCE} ETH out of ${total.toLocaleString()}`);
  return balances;
}

// --- Phase 2: Token Discovery + Pricing ---

async function analyzeTokens(rpc, fundedContracts, discovery, pricer) {
  const results = [];
  const total = fundedContracts.length;
  let processed = 0;

  console.log(`\n[Phase 2] Running TokenDiscovery + DexPricer on ${total} funded contracts...`);
  console.log(`  Concurrency: ${TOKEN_DISCOVERY_CONCURRENCY}\n`);

  // Get ETH/USD price once
  const ethUsd = await pricer.getEthUsdPrice();
  console.log(`  ETH/USD: $${ethUsd ? ethUsd.toFixed(2) : 'unknown'}\n`);

  // Process in parallel batches
  for (let i = 0; i < fundedContracts.length; i += TOKEN_DISCOVERY_CONCURRENCY) {
    const batch = fundedContracts.slice(i, i + TOKEN_DISCOVERY_CONCURRENCY);

    const promises = batch.map(async ({ address, ethBalance }) => {
      const entry = {
        address,
        ethBalance: ethBalance.eth,
        tokens: {},
        tokenCount: 0,
        totalTokenEthValue: 0,
        totalValueEth: ethBalance.eth,
        totalValueUsd: ethUsd ? ethBalance.eth * ethUsd : null,
      };

      try {
        // Discover and price tokens
        const tokens = await discovery.discoverAndPrice(address, {
          fromBlock: 10000000,
          toBlock: 'latest',
          minEthValue: 0.0001,
        });

        if (Object.keys(tokens).length > 0) {
          entry.tokens = {};
          for (const [tokenAddr, info] of Object.entries(tokens)) {
            entry.tokens[tokenAddr] = {
              symbol: info.symbol,
              decimals: info.decimals,
              balance: info.balanceFormatted,
              ethValue: info.ethValue || 0,
              usdValue: info.usdValue || null,
              priceSource: info.priceSource || null,
            };
            entry.totalTokenEthValue += (info.ethValue || 0);
          }
          entry.tokenCount = Object.keys(entry.tokens).length;
          entry.totalValueEth = entry.ethBalance + entry.totalTokenEthValue;
          entry.totalValueUsd = ethUsd ? entry.totalValueEth * ethUsd : null;
        }
      } catch (err) {
        entry.error = err.message;
      }

      return entry;
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    processed += batch.length;

    if (processed % 50 === 0 || processed >= total) {
      const pct = ((processed / total) * 100).toFixed(1);
      const totalEth = results.reduce((s, r) => s + r.totalValueEth, 0);
      console.log(`  ${processed}/${total} analyzed (${pct}%) — running total: ${totalEth.toFixed(4)} ETH`);
    }

    // Save checkpoint periodically
    if (processed % CHECKPOINT_INTERVAL === 0) {
      saveCheckpoint({ phase: 2, processed, results: results.length });
    }
  }

  console.log(`\n[Phase 2] Complete: ${total} contracts valued`);
  return { results, ethUsd };
}

// --- Checkpoint ---

function saveCheckpoint(data) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ ...data, timestamp: Date.now() }));
  } catch { /* ignore */ }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => !a.startsWith('--')) || DEFAULT_INPUT;
  const resume = args.includes('--resume');

  console.log('=== Sweet Spot Analyzer — Phase 2 Pipeline ===\n');

  // Check input file
  if (!fs.existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    console.error('The event discovery scan (Phase 1) must complete first.');
    console.error('Expected: one contract address per line');
    process.exit(1);
  }

  // Read contract addresses
  const raw = fs.readFileSync(inputFile, 'utf-8');
  const allAddresses = raw.trim().split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => /^0x[0-9a-f]{40}$/i.test(line));

  console.log(`Input: ${inputFile}`);
  console.log(`Contracts loaded: ${allAddresses.toLocaleString()}`);

  // Dedup
  const uniqueAddresses = [...new Set(allAddresses)];
  if (uniqueAddresses.length < allAddresses.length) {
    console.log(`Deduped: ${uniqueAddresses.length} unique (${allAddresses.length - uniqueAddresses.length} duplicates removed)`);
  }

  // Init RPC + modules
  const rpc = new RpcClient('http://127.0.0.1:8545');
  const health = await rpc.checkHealth();
  console.log(`\nAggregator: ${health.status} (${health.availableProviders}/${health.totalProviders} providers)`);
  if (health.status !== 'ok') {
    console.error('Aggregator not healthy. Start with: node index.js');
    process.exit(1);
  }

  const pricer = new DexPricer(rpc);
  const discovery = new TokenDiscovery(rpc, pricer);

  const startTime = Date.now();

  // Phase 1: Batch balance check
  const fundedMap = await batchCheckBalances(rpc, uniqueAddresses);

  const fundedContracts = [];
  for (const [addr, bal] of fundedMap) {
    fundedContracts.push({ address: addr, ethBalance: bal });
  }

  // Sort by ETH balance descending (check richest first)
  fundedContracts.sort((a, b) => b.ethBalance.eth - a.ethBalance.eth);

  console.log(`\nFunded contracts to analyze: ${fundedContracts.length}`);
  if (fundedContracts.length > 0) {
    const topBal = fundedContracts[0].ethBalance.eth;
    const totalEth = fundedContracts.reduce((s, c) => s + c.ethBalance.eth, 0);
    console.log(`  Top balance: ${topBal.toFixed(6)} ETH`);
    console.log(`  Total ETH in funded contracts: ${totalEth.toFixed(4)} ETH`);
  }

  if (fundedContracts.length === 0) {
    console.log('\nNo funded contracts found. Nothing to analyze.');
    const emptyOutput = {
      generatedAt: new Date().toISOString(),
      input: inputFile,
      totalScanned: uniqueAddresses.length,
      funded: 0,
      contracts: [],
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(emptyOutput, null, 2));
    console.log(`Output: ${OUTPUT_FILE}`);
    process.exit(0);
  }

  // Phase 2: Token discovery + pricing
  const { results, ethUsd } = await analyzeTokens(rpc, fundedContracts, discovery, pricer);

  // Sort by total value
  results.sort((a, b) => b.totalValueEth - a.totalValueEth);

  // Compute summary stats
  const totalEth = results.reduce((s, r) => s + r.totalValueEth, 0);
  const totalUsd = ethUsd ? totalEth * ethUsd : null;
  const withTokens = results.filter(r => r.tokenCount > 0).length;

  // Write output
  const output = {
    generatedAt: new Date().toISOString(),
    input: inputFile,
    scanRange: { startBlock: 10000000, endBlock: 35000000 },
    ethUsd,
    summary: {
      totalScanned: uniqueAddresses.length,
      funded: fundedContracts.length,
      fundedRate: `${((fundedContracts.length / uniqueAddresses.length) * 100).toFixed(2)}%`,
      contractsWithTokens: withTokens,
      totalValueEth: totalEth,
      totalValueUsd: totalUsd,
      elapsedMs: Date.now() - startTime,
    },
    contracts: results,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('\n=== SWEET SPOT ANALYSIS COMPLETE ===\n');
  console.log(`Contracts scanned:    ${uniqueAddresses.length.toLocaleString()}`);
  console.log(`Funded (>= 0.001 ETH): ${fundedContracts.length.toLocaleString()} (${output.summary.fundedRate})`);
  console.log(`Holding tokens:       ${withTokens}`);
  console.log(`Total value:          ${totalEth.toFixed(4)} ETH${totalUsd ? ` ($${totalUsd.toFixed(2)})` : ''}`);
  console.log(`Elapsed:              ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  console.log('\n=== TOP 20 BY TOTAL VALUE ===\n');
  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    const usdStr = r.totalValueUsd ? ` ($${r.totalValueUsd.toFixed(2)})` : '';
    const tokenStr = r.tokenCount > 0 ? ` [${r.tokenCount} tokens = ${r.totalTokenEthValue.toFixed(4)} ETH]` : '';
    console.log(`  #${i + 1} ${r.address}: ${r.totalValueEth.toFixed(6)} ETH${usdStr}${tokenStr}`);
  }

  console.log(`\nOutput: ${OUTPUT_FILE}`);

  // Cleanup checkpoint
  try { fs.unlinkSync(CHECKPOINT_FILE); } catch { /* ignore */ }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
