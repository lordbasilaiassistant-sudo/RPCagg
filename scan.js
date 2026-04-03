/**
 * Scanner CLI — run chain scans against the local RPC aggregator.
 *
 * Usage:
 *   node scan.js blocks              # scan recent blocks forward
 *   node scan.js blocks --back       # scan backward from checkpoint
 *   node scan.js contracts           # classify discovered contracts
 *   node scan.js status              # show scan progress
 *
 * Requires the aggregator to be running (npm start).
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, BlockScanner, ContractScanner } = require('./src/scanner');
const { makeLogger, setLevel } = require('./src/logger');

const log = makeLogger('scan');
setLevel(process.env.LOG_LEVEL || 'info');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Simple JSONL append writer
function jsonlWriter(filename) {
  const filePath = path.join(DATA_DIR, filename);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return {
    write(obj) { stream.write(JSON.stringify(obj) + '\n'); },
    close() { stream.end(); },
  };
}

async function scanBlocks(client, backward = false) {
  const blockWriter = jsonlWriter('blocks.jsonl');
  const contractWriter = jsonlWriter('contracts.jsonl');
  let blockCount = 0;
  let contractCount = 0;

  const scanner = new BlockScanner(client, {
    batchSize: 10,
    concurrency: 5,
    direction: backward ? 'backward' : 'forward',
    onBlock: (block) => {
      blockWriter.write(block);
      blockCount++;
      if (blockCount % 100 === 0) {
        log.info(`blocks: ${blockCount} | latest: ${block.number}`);
      }
    },
    onContracts: (contracts) => {
      for (const c of contracts) {
        contractWriter.write(c);
        contractCount++;
      }
    },
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.info('stopping scan...');
    scanner.stop();
  });

  log.info(`starting block scan (${backward ? 'backward' : 'forward'})`);
  await scanner.start();

  blockWriter.close();
  contractWriter.close();
  log.info(`done: ${blockCount} blocks, ${contractCount} contract deploys`);
  log.info(`data: ${path.join(DATA_DIR, 'blocks.jsonl')}`);
}

async function scanContracts(client) {
  // Read contract deployments from blocks.jsonl
  const contractsFile = path.join(DATA_DIR, 'contracts.jsonl');
  if (!fs.existsSync(contractsFile)) {
    log.error('no contracts.jsonl found — run "node scan.js blocks" first');
    process.exit(1);
  }

  const lines = fs.readFileSync(contractsFile, 'utf8').trim().split('\n');
  const deployments = lines.map(l => JSON.parse(l));

  // Get contract addresses from tx receipts
  log.info(`found ${deployments.length} contract deployments, fetching addresses...`);

  const receiptCalls = deployments.map(d => ({
    method: 'eth_getTransactionReceipt',
    params: [d.txHash],
  }));

  const receipts = await client.batchChunked(receiptCalls, 25);
  const addresses = receipts
    .filter(r => r && !r.error && r.contractAddress)
    .map(r => r.contractAddress);

  log.info(`resolved ${addresses.length} contract addresses, classifying...`);

  const resultWriter = jsonlWriter('contract-analysis.jsonl');
  let classified = 0;

  const scanner = new ContractScanner(client, {
    batchSize: 10,
    onContract: (info) => {
      resultWriter.write(info);
      classified++;
      if (classified % 50 === 0) {
        log.info(`classified: ${classified}/${addresses.length}`);
      }
    },
  });

  process.on('SIGINT', () => {
    log.info('stopping scan...');
    scanner.stop();
  });

  scanner.running = true;
  await scanner.scanAddresses(addresses);
  resultWriter.close();

  // Summary
  const analysis = fs.readFileSync(path.join(DATA_DIR, 'contract-analysis.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

  const proxies = analysis.filter(c => c.isProxy);
  const factories = analysis.filter(c => c.isFactory);
  const destructable = analysis.filter(c => c.hasSelfdestruct);

  log.info(`Classification complete:`);
  log.info(`  Total contracts: ${analysis.length}`);
  log.info(`  Proxies: ${proxies.length} (${proxies.map(p => p.proxyType).filter((v,i,a) => a.indexOf(v) === i).join(', ')})`);
  log.info(`  Factories: ${factories.length}`);
  log.info(`  Has SELFDESTRUCT: ${destructable.length}`);
}

async function showStatus() {
  const client = new RpcClient(RPC_URL);
  const health = await client.checkHealth();
  console.log('\nAggregator:', health);

  const stats = await client.getStats();
  if (stats) {
    console.log('Router:', stats.router);
    console.log('Server:', stats.server);
  }

  // Show checkpoint states
  console.log('\nCheckpoints:');
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.checkpoint.json')) {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        console.log(`  ${f}: block ${data.lastBlock || 'none'} (${data.updatedAt || 'never'})`);
      }
    }
  }

  // Show data file sizes
  console.log('\nData files:');
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.jsonl')) {
        const stat = fs.statSync(path.join(DATA_DIR, f));
        const lines = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').trim().split('\n').length;
        console.log(`  ${f}: ${lines} records (${(stat.size / 1024).toFixed(1)}KB)`);
      }
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  const flags = process.argv.slice(3);

  const client = new RpcClient(RPC_URL);

  // Pre-flight: check aggregator is running
  const health = await client.checkHealth();
  if (health.status === 'unreachable') {
    log.error(`aggregator not reachable at ${RPC_URL} — run "npm start" first`);
    process.exit(1);
  }
  log.info(`aggregator: ${health.availableProviders} providers available`);

  switch (cmd) {
    case 'blocks':
      await scanBlocks(client, flags.includes('--back'));
      break;
    case 'contracts':
      await scanContracts(client);
      break;
    case 'status':
      await showStatus();
      break;
    default:
      console.log('Usage:');
      console.log('  node scan.js blocks [--back]   Scan blocks (forward or backward)');
      console.log('  node scan.js contracts          Classify discovered contracts');
      console.log('  node scan.js status             Show scan progress');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
