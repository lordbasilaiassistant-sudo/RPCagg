/**
 * Scanner Integration Test
 * Boots the aggregator, runs each scanner module, verifies output.
 */

const { providers } = require('./src/providers');
const { HealthChecker } = require('./src/health');
const { Router } = require('./src/router');
const { createServer } = require('./src/server');
const { setLevel } = require('./src/logger');
const { RpcClient, BlockScanner, ContractScanner } = require('./src/scanner');

setLevel('warn');

let server, hc, baseUrl;

async function setup() {
  hc = new HealthChecker(providers);
  await hc.checkAll();
  const router = new Router(hc, 'fastest');
  const app = createServer(router, hc);
  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function teardown() {
  hc.stop();
  server.close();
}

// Test helpers
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

async function testRpcClient() {
  console.log('\n--- RpcClient ---');
  const client = new RpcClient(baseUrl);

  // Health check
  const health = await client.checkHealth();
  assert(health.status === 'ok', 'aggregator health is ok');
  assert(health.availableProviders > 0, `${health.availableProviders} providers available`);

  // Single call
  const blockNum = await client.call('eth_blockNumber');
  assert(typeof blockNum === 'string' && blockNum.startsWith('0x'), `eth_blockNumber returned ${blockNum}`);

  // Batch call
  const batch = await client.batch([
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_chainId', params: [] },
    { method: 'eth_gasPrice', params: [] },
  ]);
  assert(batch.length === 3, `batch returned ${batch.length} results`);
  assert(batch[1] === '0x2105', `chainId is 0x2105 (Base: ${parseInt(batch[1], 16)})`);

  // Chunked batch
  const calls = Array.from({ length: 25 }, (_, i) => ({
    method: 'eth_getBlockByNumber',
    params: [`0x${(parseInt(blockNum, 16) - i).toString(16)}`, false],
  }));
  const chunked = await client.batchChunked(calls, 10);
  assert(chunked.length === 25, `chunked batch returned ${chunked.length} results`);
  const validBlocks = chunked.filter(b => b && !b.error && b.number);
  assert(validBlocks.length > 20, `${validBlocks.length}/25 blocks valid`);

  // Error handling
  try {
    await client.call('eth_nonexistent_method');
    assert(false, 'should have thrown on invalid method');
  } catch (err) {
    assert(err.name === 'RpcError', `RpcError thrown for invalid method: ${err.message}`);
  }

  // Stats
  const stats = client.getClientStats();
  assert(stats.calls > 0, `client stats tracked: ${stats.calls} calls`);
}

async function testBlockScanner() {
  console.log('\n--- BlockScanner ---');
  const client = new RpcClient(baseUrl);

  const blocks = [];
  const contracts = [];

  const scanner = new BlockScanner(client, {
    batchSize: 5,
    concurrency: 2,
    onBlock: (b) => blocks.push(b),
    onContracts: (c) => contracts.push(...c),
  });

  // Set checkpoint to recent blocks
  const head = parseInt(await client.call('eth_blockNumber'), 16);
  scanner.checkpoint.data.lastBlock = head - 20;

  // Run scan (will scan ~20 blocks)
  setTimeout(() => scanner.stop(), 10000); // safety timeout
  await scanner.start();

  assert(blocks.length > 0, `scanned ${blocks.length} blocks`);
  assert(blocks[0].number > 0, `first block number: ${blocks[0].number}`);
  assert(blocks[0].txCount >= 0, `first block txCount: ${blocks[0].txCount}`);
  assert(blocks[0].timestamp > 0, `first block has timestamp`);
  assert(blocks[0].gasUsed >= 0, `first block has gasUsed`);

  const totalTxs = blocks.reduce((s, b) => s + b.txCount, 0);
  console.log(`  INFO: ${blocks.length} blocks, ${totalTxs} txs, ${contracts.length} contract deploys`);

  // Checkpoint should be updated
  assert(scanner.checkpoint.lastBlock >= head - 1, `checkpoint updated to ${scanner.checkpoint.lastBlock}`);

  // Stats
  const stats = scanner.getStats();
  assert(stats.processed > 0, `scanner processed ${stats.processed} blocks`);
}

async function testContractScanner() {
  console.log('\n--- ContractScanner ---');
  const client = new RpcClient(baseUrl);

  const results = [];
  const scanner = new ContractScanner(client, {
    batchSize: 5,
    onContract: (c) => results.push(c),
  });
  scanner.running = true;

  // Test with known Base contracts
  const testAddresses = [
    '0x4200000000000000000000000000000000000006', // WETH on Base
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    '0x0000000000000000000000000000000000000000', // zero address (EOA)
    '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
  ];

  const scanned = await scanner.scanAddresses(testAddresses);

  assert(scanned.length >= 2, `found ${scanned.length} contracts (expected >=2)`);

  const weth = scanned.find(c => c.address.toLowerCase() === testAddresses[0].toLowerCase());
  if (weth) {
    assert(weth.codeSize > 0, `WETH has code (${weth.codeSize} bytes)`);
    assert(weth.selectors.length > 0, `WETH has ${weth.selectors.length} selectors`);
    console.log(`  INFO: WETH — proxy: ${weth.isProxy}, type: ${weth.proxyType}, selectors: ${weth.selectors.length}`);
  }

  const mc3 = scanned.find(c => c.address.toLowerCase() === testAddresses[3].toLowerCase());
  if (mc3) {
    assert(mc3.codeSize > 0, `Multicall3 has code (${mc3.codeSize} bytes)`);
    console.log(`  INFO: Multicall3 — factory: ${mc3.isFactory}, selfdestruct: ${mc3.hasSelfdestruct}, selectors: ${mc3.selectors.length}`);
  }
}

async function main() {
  console.log('================================================');
  console.log('  SCANNER INTEGRATION TEST');
  console.log('================================================');

  await setup();
  const healthy = hc.getAvailable().length;
  console.log(`\nAggregator: ${baseUrl} | ${healthy}/${providers.length} providers`);

  await testRpcClient();
  await testBlockScanner();
  await testContractScanner();

  teardown();

  console.log('\n================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('================================================\n');

  // Clean up test checkpoint files
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, 'data');
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.endsWith('.checkpoint.json')) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    }
  } catch (e) { /* ignore */ }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
