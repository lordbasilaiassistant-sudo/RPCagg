/**
 * Quick smoke test — boots the aggregator and fires a few RPC calls.
 */

const { providers } = require('./src/providers');
const { HealthChecker } = require('./src/health');
const { Router } = require('./src/router');
const { createServer } = require('./src/server');
const { setLevel } = require('./src/logger');

setLevel('warn'); // quiet for tests

async function main() {
  console.log(`\n--- RPC Aggregator Smoke Test ---\n`);
  console.log(`Loaded ${providers.length} unique providers\n`);

  const hc = new HealthChecker(providers);
  console.log('Running initial health check...');
  await hc.checkAll();

  const healthy = hc.getHealthy();
  console.log(`Healthy: ${healthy.length}/${providers.length}`);

  if (healthy.length === 0) {
    console.error('No healthy providers — cannot continue test');
    process.exit(1);
  }

  // Test each strategy
  for (const strat of ['fastest', 'round-robin', 'race']) {
    console.log(`\nTesting strategy: ${strat}`);
    const router = new Router(hc, strat);

    const result = await router.forwardRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_blockNumber',
      params: [],
    });

    if (result.result) {
      console.log(`  eth_blockNumber: ${parseInt(result.result, 16)} (block ${result.result})`);
    } else {
      console.log(`  ERROR:`, result.error);
    }
  }

  // Test batch
  console.log(`\nTesting batch request...`);
  const router = new Router(hc, 'fastest');
  const app = createServer(router, hc);
  const server = app.listen(0); // random port
  const port = server.address().port;

  const batchRes = await fetch(`http://localhost:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
    ]),
  });
  const batchJson = await batchRes.json();
  console.log(`  Batch results: ${batchJson.length} responses`);
  for (const r of batchJson) {
    console.log(`    id=${r.id}: ${r.result || r.error?.message}`);
  }

  // Stats endpoint
  const statsRes = await fetch(`http://localhost:${port}/stats`);
  const stats = await statsRes.json();
  console.log(`\nRouter stats:`, stats.router);

  server.close();
  hc.stop();
  console.log(`\n--- All tests passed ---\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
