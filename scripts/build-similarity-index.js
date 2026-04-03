#!/usr/bin/env node
/**
 * Build the bytecode similarity index for all scanned contracts.
 *
 * Fetches bytecode via RPC, computes opcode-skeleton hashes,
 * groups contracts into clusters, and demonstrates exploit propagation.
 *
 * Usage: node scripts/build-similarity-index.js [vectors-file]
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, BytecodeSimilarity } = require('../src/scanner');
const { makeLogger, setLevel } = require('../src/logger');

const log = makeLogger('sim-index');
setLevel(process.env.LOG_LEVEL || 'info');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  const rpc = new RpcClient(RPC);
  const sim = new BytecodeSimilarity();

  // Load contract addresses from vectors file
  const vectorsFile = process.argv[2] || path.join(DATA_DIR, 'vectors-1950000-2050000.jsonl');
  if (!fs.existsSync(vectorsFile)) {
    console.error('Vectors file not found:', vectorsFile);
    process.exit(1);
  }

  const lines = fs.readFileSync(vectorsFile, 'utf8').trim().split('\n');
  const vectors = lines.map(l => JSON.parse(l));
  log.info('loaded ' + vectors.length + ' contract addresses from ' + path.basename(vectorsFile));

  // Fetch bytecode in batches via RPC
  const BATCH = 50;
  let fetched = 0;
  let indexed = 0;

  for (let i = 0; i < vectors.length; i += BATCH) {
    const chunk = vectors.slice(i, i + BATCH);
    const calls = chunk.map(v => ({
      method: 'eth_getCode',
      params: [v.address, 'latest'],
    }));

    let codes;
    try {
      codes = await rpc.batchChunked(calls, BATCH);
    } catch (err) {
      log.warn('batch failed at offset ' + i + ': ' + err.message);
      continue;
    }

    for (let j = 0; j < chunk.length; j++) {
      const code = codes[j];
      if (!code || code === '0x' || typeof code !== 'string' || code.error) continue;

      fetched++;
      const result = sim.index(chunk[j].address, code);
      if (result) indexed++;
    }

    if (i > 0 && i % 500 === 0) {
      log.info('  fetched ' + fetched + '/' + vectors.length + ' | indexed ' + indexed);
    }
  }

  log.info('bytecode fetch complete: ' + fetched + ' contracts with code, ' + indexed + ' indexed');

  // Get cluster stats
  const stats = sim.getStats();
  log.info('clusters: ' + stats.totalClusters + ' unique hashes, ' + stats.multiMemberClusters + ' with 2+ members');

  // Demonstrate: simulate finding an exploit in one contract and propagating
  const treasures = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'treasure-1950000-2050000.json'), 'utf8')).treasures;
  log.info('\n--- EXPLOIT PROPAGATION DEMO ---');

  for (const t of treasures.slice(0, 5)) {
    const hash = sim.getHash(t.address);
    if (!hash) continue;

    const similar = sim.findSimilar(t.address, 0.8);
    if (similar.length > 0) {
      log.info(t.address + ' (hash: ' + hash + ')');
      log.info('  ' + similar.length + ' similar contracts found:');
      for (const s of similar.slice(0, 5)) {
        log.info('    ' + s.address + ' (similarity: ' + s.similarity.toFixed(3) + ', type: ' + s.matchType + ')');
      }

      // Simulate propagation
      const flagged = sim.propagateFlag(t.address, 'potential-treasure', {
        reason: 'Same bytecode skeleton as contract with ETH balance',
        sourceEthBalance: t.ethBalance,
      }, 0.8);
      if (flagged > 0) {
        log.info('  -> propagated flag to ' + flagged + ' contracts');
      }
    }
  }

  // Write results
  const exportData = sim.export();

  // Add the treasure addresses and their cluster info
  exportData.treasureAnalysis = treasures.map(t => {
    const hash = sim.getHash(t.address);
    const similar = hash ? sim.findSimilar(t.address, 0.8) : [];
    return {
      address: t.address,
      ethBalance: t.ethBalance,
      skeletonHash: hash,
      clusterSize: hash ? (sim.getStats().largestClusters.find(c => c.hash === hash)?.size || 1) : 0,
      similarContracts: similar.length,
      topMatches: similar.slice(0, 5).map(s => ({
        address: s.address,
        similarity: s.similarity,
        matchType: s.matchType,
      })),
    };
  });

  const outFile = path.join(DATA_DIR, 'bytecode-similarity-index.json');
  fs.writeFileSync(outFile, JSON.stringify(exportData, null, 2));
  log.info('\nindex written to ' + outFile);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('  BYTECODE SIMILARITY INDEX');
  console.log('='.repeat(60));
  console.log('  Contracts indexed: ' + stats.totalIndexed);
  console.log('  Unique skeleton hashes: ' + stats.totalClusters);
  console.log('  Multi-member clusters: ' + stats.multiMemberClusters);
  console.log('  Flagged contracts: ' + stats.totalFlagged);
  console.log('');
  console.log('  Largest clusters (same bytecode skeleton):');
  for (const c of stats.largestClusters.slice(0, 10)) {
    console.log('    hash ' + c.hash + ': ' + c.size + ' contracts (sample: ' + c.sample[0] + ')');
  }
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
