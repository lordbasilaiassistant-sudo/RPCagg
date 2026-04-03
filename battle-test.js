/**
 * Battle Test Suite — RPC Aggregator
 *
 * Simulates real chain-scanning workloads:
 *   1. Throughput burst    — max requests/sec raw capacity
 *   2. Sustained load      — 60s continuous fire, track degradation
 *   3. Batch scaling       — find batch size limits per provider
 *   4. Concurrent scanning — parallel block + receipt + log fetching
 *   5. Rate limit detection— hammer until providers push back
 *   6. Failover cascade    — simulate mass provider failure
 *   7. Memory pressure     — large payloads (eth_getLogs wide ranges)
 *   8. Chain scan sim      — sequential block crawl like real indexer
 *
 * Usage: node battle-test.js [test-name]
 *   node battle-test.js              # run all
 *   node battle-test.js throughput   # run one
 */

const { providers } = require('./src/providers');
const { HealthChecker } = require('./src/health');
const { Router } = require('./src/router');
const { createServer } = require('./src/server');
const { setLevel } = require('./src/logger');

setLevel('warn');

// ─── Helpers ───────────────────────────────────────────────

function rpc(method, params = []) {
  return { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params };
}

async function fireAt(url, body) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const latency = Date.now() - start;
    const hasError = Array.isArray(json)
      ? json.some(r => r.error)
      : !!json.error;
    return { ok: !hasError, latency, json, status: res.status };
  } catch (err) {
    return { ok: false, latency: Date.now() - start, error: err.message };
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(latencies) {
  if (latencies.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    avg: Math.round(sum / latencies.length),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  };
}

function bar(pct, width = 30) {
  const filled = Math.round(pct / 100 * width);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

// ─── Test Infrastructure ───────────────────────────────────

let serverInstance, baseUrl, hc, router;

async function boot() {
  hc = new HealthChecker(providers);
  await hc.checkAll();
  router = new Router(hc, 'fastest');
  const app = createServer(router, hc);
  return new Promise(resolve => {
    serverInstance = app.listen(0, () => {
      baseUrl = `http://localhost:${serverInstance.address().port}`;
      resolve();
    });
  });
}

function shutdown() {
  hc.stop();
  serverInstance.close();
}

// ─── Tests ─────────────────────────────────────────────────

const tests = {};

/**
 * TEST 1: Throughput Burst
 * Fire N requests as fast as possible, measure capacity.
 */
tests.throughput = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 1: THROUGHPUT BURST');
  console.log('══════════════════════════════════════════════');

  const TOTAL = 200;
  const CONCURRENCY_LEVELS = [1, 5, 10, 25, 50, 100];

  for (const concurrency of CONCURRENCY_LEVELS) {
    const latencies = [];
    let errors = 0;
    const start = Date.now();

    // Fire in waves of `concurrency`
    for (let i = 0; i < TOTAL; i += concurrency) {
      const batch = [];
      for (let j = 0; j < concurrency && (i + j) < TOTAL; j++) {
        batch.push(fireAt(baseUrl, rpc('eth_blockNumber')));
      }
      const results = await Promise.all(batch);
      for (const r of results) {
        if (r.ok) latencies.push(r.latency);
        else errors++;
      }
    }

    const elapsed = Date.now() - start;
    const rps = Math.round(TOTAL / (elapsed / 1000));
    const s = stats(latencies);
    const errRate = ((errors / TOTAL) * 100).toFixed(1);

    console.log(`\n  Concurrency: ${concurrency}`);
    console.log(`    RPS: ${rps} | Errors: ${errors}/${TOTAL} (${errRate}%)`);
    console.log(`    Latency — avg: ${s.avg}ms | p50: ${s.p50}ms | p95: ${s.p95}ms | p99: ${s.p99}ms`);
    console.log(`    ${bar(100 - parseFloat(errRate))} success`);
  }
};

/**
 * TEST 2: Sustained Load
 * Continuous fire for 30s at fixed concurrency, track degradation over time.
 */
tests.sustained = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 2: SUSTAINED LOAD (30s)');
  console.log('══════════════════════════════════════════════');

  const DURATION_MS = 30_000;
  const CONCURRENCY = 20;
  const WINDOW_MS = 5_000; // report every 5s

  let running = true;
  let windowStart = Date.now();
  let windowLatencies = [];
  let windowErrors = 0;
  let totalReqs = 0;
  let totalErrors = 0;

  setTimeout(() => { running = false; }, DURATION_MS);

  console.log(`\n  Firing ${CONCURRENCY} concurrent for ${DURATION_MS / 1000}s...\n`);
  console.log('  Window    | RPS   | Errors | Avg    | p95    | p99');
  console.log('  ----------|-------|--------|--------|--------|-------');

  async function worker() {
    while (running) {
      const r = await fireAt(baseUrl, rpc('eth_blockNumber'));
      totalReqs++;
      if (r.ok) {
        windowLatencies.push(r.latency);
      } else {
        windowErrors++;
        totalErrors++;
      }

      // Report window
      if (Date.now() - windowStart >= WINDOW_MS) {
        const s = stats(windowLatencies);
        const rps = Math.round(windowLatencies.length / (WINDOW_MS / 1000));
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`  ${String(elapsed).padStart(4)}s     | ${String(rps).padStart(5)} | ${String(windowErrors).padStart(6)} | ${String(s.avg).padStart(4)}ms | ${String(s.p95).padStart(4)}ms | ${String(s.p99).padStart(4)}ms`);
        windowLatencies = [];
        windowErrors = 0;
        windowStart = Date.now();
      }
    }
  }

  const startTime = Date.now();
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`\n  Total: ${totalReqs} requests | ${totalErrors} errors (${((totalErrors/totalReqs)*100).toFixed(1)}%)`);
};

/**
 * TEST 3: Batch Size Scaling
 * Find optimal batch size before providers start choking.
 */
tests.batch = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 3: BATCH SIZE SCALING');
  console.log('══════════════════════════════════════════════');

  const BATCH_SIZES = [1, 5, 10, 25, 50, 100, 200, 500];

  for (const size of BATCH_SIZES) {
    const batch = Array.from({ length: size }, (_, i) =>
      rpc('eth_getBlockByNumber', [`0x${(44000000 + i).toString(16)}`, false])
    );

    const r = await fireAt(baseUrl, batch);
    const results = r.ok ? (Array.isArray(r.json) ? r.json : [r.json]) : [];
    const errors = results.filter(x => x.error).length;

    const status = !r.ok ? 'FAIL' : errors > 0 ? `PARTIAL (${errors} errs)` : 'OK';
    console.log(`\n  Batch ${String(size).padStart(3)}: ${r.latency}ms | ${status}`);
    console.log(`    ${bar(r.ok ? ((size - errors) / size * 100) : 0)}`);

    if (!r.ok) {
      console.log(`    Error: ${r.error || 'HTTP error'}`);
      break;
    }
  }
};

/**
 * TEST 4: Concurrent Chain Scanning Simulation
 * Simulates what a real indexer does — fetch block, receipts, logs in parallel.
 */
tests.scan = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 4: CHAIN SCAN SIMULATION');
  console.log('══════════════════════════════════════════════');

  // Get current block
  const cur = await fireAt(baseUrl, rpc('eth_blockNumber'));
  const headBlock = parseInt(cur.json.result, 16);
  const START_BLOCK = headBlock - 100;
  const BLOCKS_TO_SCAN = 50;
  const CONCURRENCY = 10;

  console.log(`\n  Scanning blocks ${START_BLOCK} to ${START_BLOCK + BLOCKS_TO_SCAN - 1}`);
  console.log(`  Head: ${headBlock} | Concurrency: ${CONCURRENCY}\n`);

  let scanned = 0;
  let txCount = 0;
  let errors = 0;
  const start = Date.now();

  async function scanBlock(blockNum) {
    const hex = `0x${blockNum.toString(16)}`;

    // Fetch block with full tx objects
    const blockRes = await fireAt(baseUrl, rpc('eth_getBlockByNumber', [hex, true]));
    if (!blockRes.ok || blockRes.json.error) { errors++; return; }

    const block = blockRes.json.result;
    if (!block) { errors++; return; }

    const txs = block.transactions || [];
    txCount += txs.length;

    // Fetch receipts for first 5 txs (simulates receipt scanning)
    if (txs.length > 0) {
      const receiptBatch = txs.slice(0, 5).map(tx =>
        rpc('eth_getTransactionReceipt', [typeof tx === 'string' ? tx : tx.hash])
      );
      const receiptsRes = await fireAt(baseUrl, receiptBatch);
      if (!receiptsRes.ok) errors++;
    }

    scanned++;
  }

  // Process in waves
  for (let i = 0; i < BLOCKS_TO_SCAN; i += CONCURRENCY) {
    const wave = [];
    for (let j = 0; j < CONCURRENCY && (i + j) < BLOCKS_TO_SCAN; j++) {
      wave.push(scanBlock(START_BLOCK + i + j));
    }
    await Promise.all(wave);
    process.stdout.write(`  Progress: ${scanned}/${BLOCKS_TO_SCAN} blocks | ${txCount} txs | ${errors} errors\r`);
  }

  const elapsed = Date.now() - start;
  const blocksPerSec = (scanned / (elapsed / 1000)).toFixed(1);

  console.log(`\n\n  Results:`);
  console.log(`    Blocks scanned: ${scanned}`);
  console.log(`    Transactions found: ${txCount}`);
  console.log(`    Blocks/sec: ${blocksPerSec}`);
  console.log(`    Errors: ${errors}`);
  console.log(`    Time: ${(elapsed / 1000).toFixed(1)}s`);
};

/**
 * TEST 5: Rate Limit Detection
 * Hammer a single method rapidly to trigger provider rate limits.
 */
tests.ratelimit = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 5: RATE LIMIT DETECTION');
  console.log('══════════════════════════════════════════════');

  const BURSTS = 10;
  const PER_BURST = 50;

  console.log(`\n  Firing ${BURSTS} bursts of ${PER_BURST} (${BURSTS * PER_BURST} total)...\n`);

  let totalOk = 0;
  let totalErr = 0;
  let rateLimited = 0;

  for (let burst = 0; burst < BURSTS; burst++) {
    const promises = Array.from({ length: PER_BURST }, () =>
      fireAt(baseUrl, rpc('eth_blockNumber'))
    );
    const results = await Promise.all(promises);

    let ok = 0, err = 0, rl = 0;
    for (const r of results) {
      if (r.ok) { ok++; totalOk++; }
      else {
        err++; totalErr++;
        // Check for rate limit signatures
        const errMsg = JSON.stringify(r.json || r.error || '');
        if (errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('limit') || errMsg.includes('Too Many')) {
          rl++; rateLimited++;
        }
      }
    }

    console.log(`  Burst ${burst + 1}: ${ok} ok | ${err} err | ${rl} rate-limited`);
  }

  console.log(`\n  Total: ${totalOk} ok | ${totalErr} err | ${rateLimited} rate-limited`);
  if (rateLimited > 0) {
    console.log(`  ⚠ Rate limiting detected — aggregator needs backpressure handling`);
  } else {
    console.log(`  No rate limiting hit at this volume`);
  }
};

/**
 * TEST 6: Provider Failover Cascade
 * Progressively disable providers, verify the system degrades gracefully.
 */
tests.failover = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 6: FAILOVER CASCADE');
  console.log('══════════════════════════════════════════════');

  const totalProviders = hc.providers.length;
  console.log(`\n  ${totalProviders} providers loaded. Simulating progressive failure...\n`);

  // Save original states
  const origStates = new Map();
  for (const p of hc.providers) {
    origStates.set(p.name, { ...hc.getState(p.name) });
  }

  // Progressively mark providers as unhealthy
  const steps = [0, 25, 50, 75, 90, 100];

  for (const pct of steps) {
    // Restore all first
    for (const p of hc.providers) {
      const s = hc.getState(p.name);
      s.healthy = true;
      s.failures = 0;
    }

    // Kill pct% of providers
    const killCount = Math.floor(totalProviders * pct / 100);
    for (let i = 0; i < killCount; i++) {
      const s = hc.getState(hc.providers[i].name);
      s.healthy = false;
    }

    const healthy = hc.getHealthy().length;
    const r = await fireAt(baseUrl, rpc('eth_blockNumber'));

    console.log(`  ${pct}% down (${killCount}/${totalProviders}): healthy=${healthy} | ${r.ok ? 'OK ' + r.latency + 'ms' : 'FAIL: ' + (r.json?.error?.message || r.error)}`);
  }

  // Restore
  for (const p of hc.providers) {
    const orig = origStates.get(p.name);
    const s = hc.getState(p.name);
    Object.assign(s, orig);
  }

  console.log(`\n  Restored all providers to original state.`);
};

/**
 * TEST 7: Large Payload / eth_getLogs stress
 * Tests handling of large responses (logs over wide block ranges).
 */
tests.payload = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 7: LARGE PAYLOAD (eth_getLogs)');
  console.log('══════════════════════════════════════════════');

  const cur = await fireAt(baseUrl, rpc('eth_blockNumber'));
  const head = parseInt(cur.json.result, 16);

  // Test progressively wider block ranges
  const ranges = [10, 50, 100, 500, 1000, 2000];

  for (const range of ranges) {
    const fromBlock = `0x${(head - range).toString(16)}`;
    const toBlock = `0x${head.toString(16)}`;

    const r = await fireAt(baseUrl, rpc('eth_getLogs', [{
      fromBlock,
      toBlock,
      topics: [], // all logs
    }]));

    if (r.ok && r.json.result) {
      const logCount = r.json.result.length;
      const payloadSize = JSON.stringify(r.json).length;
      console.log(`\n  Range ${range} blocks: ${logCount} logs | ${(payloadSize / 1024).toFixed(0)}KB | ${r.latency}ms`);
    } else {
      const errMsg = r.json?.error?.message || r.error || 'unknown';
      console.log(`\n  Range ${range} blocks: FAIL — ${errMsg} (${r.latency}ms)`);
      // Most public RPCs cap at ~2000 blocks for getLogs
      if (range >= 1000) console.log(`    (Expected — most public RPCs limit log range)`);
    }
  }
};

/**
 * TEST 8: Strategy Comparison Under Load
 * Run identical workload through each strategy, compare results.
 */
tests.strategies = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 8: STRATEGY COMPARISON');
  console.log('══════════════════════════════════════════════');

  const REQUESTS = 100;
  const CONCURRENCY = 10;

  for (const strat of ['fastest', 'round-robin', 'race']) {
    router.setStrategy(strat);
    const latencies = [];
    let errors = 0;
    const start = Date.now();

    for (let i = 0; i < REQUESTS; i += CONCURRENCY) {
      const batch = [];
      for (let j = 0; j < CONCURRENCY && (i + j) < REQUESTS; j++) {
        batch.push(fireAt(baseUrl, rpc('eth_blockNumber')));
      }
      const results = await Promise.all(batch);
      for (const r of results) {
        if (r.ok) latencies.push(r.latency);
        else errors++;
      }
    }

    const elapsed = Date.now() - start;
    const s = stats(latencies);
    const rps = Math.round(REQUESTS / (elapsed / 1000));

    console.log(`\n  ${strat.toUpperCase()}`);
    console.log(`    RPS: ${rps} | Errors: ${errors}/${REQUESTS}`);
    console.log(`    avg: ${s.avg}ms | p50: ${s.p50}ms | p95: ${s.p95}ms | p99: ${s.p99}ms`);
    console.log(`    ${bar(100 - (errors / REQUESTS * 100))} reliability`);
  }

  router.setStrategy('fastest'); // reset
};

/**
 * TEST 9: Mixed Method Workload
 * Simulates real-world diverse RPC traffic pattern.
 */
tests.mixed = async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST 9: MIXED METHOD WORKLOAD');
  console.log('══════════════════════════════════════════════');

  const cur = await fireAt(baseUrl, rpc('eth_blockNumber'));
  const head = parseInt(cur.json.result, 16);
  const headHex = `0x${head.toString(16)}`;

  // Realistic method distribution
  const methods = [
    { weight: 30, fn: () => rpc('eth_blockNumber') },
    { weight: 20, fn: () => rpc('eth_getBlockByNumber', [headHex, false]) },
    { weight: 15, fn: () => rpc('eth_getBalance', ['0x4200000000000000000000000000000000000006', 'latest']) },
    { weight: 10, fn: () => rpc('eth_chainId') },
    { weight: 10, fn: () => rpc('eth_gasPrice') },
    { weight: 5,  fn: () => rpc('eth_getCode', ['0x4200000000000000000000000000000000000006', 'latest']) },
    { weight: 5,  fn: () => rpc('eth_getTransactionCount', ['0x4200000000000000000000000000000000000006', 'latest']) },
    { weight: 5,  fn: () => rpc('eth_call', [{ to: '0x4200000000000000000000000000000000000006', data: '0x70a08231000000000000000000000000000000000000000000000000000000000000dead' }, 'latest']) },
  ];

  // Build weighted pool
  const pool = [];
  for (const m of methods) {
    for (let i = 0; i < m.weight; i++) pool.push(m.fn);
  }

  const TOTAL = 200;
  const CONCURRENCY = 20;
  const methodStats = {};
  const start = Date.now();

  for (let i = 0; i < TOTAL; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && (i + j) < TOTAL; j++) {
      const fn = pool[Math.floor(Math.random() * pool.length)];
      const req = fn();
      batch.push(fireAt(baseUrl, req).then(r => ({ ...r, method: req.method })));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      if (!methodStats[r.method]) methodStats[r.method] = { ok: 0, err: 0, latencies: [] };
      if (r.ok) { methodStats[r.method].ok++; methodStats[r.method].latencies.push(r.latency); }
      else methodStats[r.method].err++;
    }
  }

  const elapsed = Date.now() - start;
  console.log(`\n  ${TOTAL} requests in ${(elapsed/1000).toFixed(1)}s (${Math.round(TOTAL/(elapsed/1000))} RPS)\n`);

  console.log('  Method                          | OK   | Err | Avg    | p95');
  console.log('  --------------------------------|------|-----|--------|-------');
  for (const [method, m] of Object.entries(methodStats).sort((a,b) => b[1].ok - a[1].ok)) {
    const s = stats(m.latencies);
    console.log(`  ${method.padEnd(32)}| ${String(m.ok).padStart(4)} | ${String(m.err).padStart(3)} | ${String(s.avg).padStart(4)}ms | ${String(s.p95).padStart(4)}ms`);
  }
};

// ─── Runner ────────────────────────────────────────────────

async function main() {
  const requested = process.argv[2];
  const available = Object.keys(tests);

  if (requested && !tests[requested]) {
    console.log(`Unknown test: ${requested}`);
    console.log(`Available: ${available.join(', ')}`);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     RPC AGGREGATOR — BATTLE TEST SUITE      ║');
  console.log('╚══════════════════════════════════════════════╝');

  await boot();
  const healthy = hc.getHealthy().length;
  console.log(`\nProviders: ${providers.length} loaded | ${healthy} healthy`);
  console.log(`Server: ${baseUrl}`);

  const toRun = requested ? [requested] : available;

  for (const name of toRun) {
    try {
      await tests[name]();
    } catch (err) {
      console.error(`\n  TEST ${name} CRASHED: ${err.message}`);
      console.error(err.stack);
    }
  }

  // Final summary
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║              FINAL REPORT                    ║');
  console.log('╚══════════════════════════════════════════════╝');

  const routerStats = router.getStats();
  console.log(`\n  Router totals:`);
  console.log(`    Requests: ${routerStats.total}`);
  console.log(`    Success:  ${routerStats.success}`);
  console.log(`    Errors:   ${routerStats.errors}`);
  console.log(`    Retries:  ${routerStats.retries}`);
  console.log(`    Strategy: ${routerStats.strategy}`);

  console.log(`\n  Provider health after test:`);
  const provStats = hc.getStats();
  const downProviders = Object.entries(provStats).filter(([_, s]) => !s.healthy);
  const slowProviders = Object.entries(provStats)
    .filter(([_, s]) => s.healthy && s.latency && s.latency > 1000)
    .sort((a, b) => b[1].latency - a[1].latency);

  if (downProviders.length > 0) {
    console.log(`\n    DOWN (${downProviders.length}):`);
    for (const [name, s] of downProviders) {
      console.log(`      ${name}: errorRate=${s.errorRate}`);
    }
  }

  if (slowProviders.length > 0) {
    console.log(`\n    SLOW (${slowProviders.length}):`);
    for (const [name, s] of slowProviders) {
      console.log(`      ${name}: ${s.latency}ms`);
    }
  }

  const healthyFinal = hc.getHealthy().length;
  console.log(`\n    Healthy: ${healthyFinal}/${providers.length}`);

  shutdown();
  console.log('\n  Done.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
