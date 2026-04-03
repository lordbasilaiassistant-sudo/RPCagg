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
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const OUR_WALLET = process.env.EXECUTOR_WALLET || '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

// EIP-1967 storage slots
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const ZERO_ADDR = '0x' + '0'.repeat(40);

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

// ─── Multicall3 helpers ─────────────────────────────
// getEthBalance(address) selector = 0x4d2301cc
function encodeGetEthBalance(addr) {
  return '0x4d2301cc' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

// eth_getStorageAt(address, slot) encoded as staticcall via Multicall3
function encodeStorageRead(addr, slot) {
  // We can't call eth_getStorageAt through Multicall3 directly, but we CAN
  // read storage via Multicall3 by using aggregate3 with target=addr and
  // callData for a known storage getter. For arbitrary slots, we batch via
  // JSON-RPC instead. This helper is for the JSON-RPC batch path.
  return { method: 'eth_getStorageAt', params: [addr, slot, 'latest'] };
}

function encodeMulticall3(calls) {
  const selector = '82ad56cb';
  let encoded = selector;
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
    encoded += call.allowFailure ? '0000000000000000000000000000000000000000000000000000000000000001' : '0000000000000000000000000000000000000000000000000000000000000000';
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

function slotToAddress(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const hex = raw.replace('0x', '').padStart(64, '0');
  const addr = '0x' + hex.slice(-40);
  if (addr === ZERO_ADDR) return null;
  return addr;
}

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
  log.info(`PHASE 2: Multicall3 balance check — ${addresses.length} contracts`);
  const funded = [];
  const MC3_BATCH = 200; // 200 getEthBalance calls per Multicall3 aggregate3()

  for (let i = 0; i < addresses.length; i += MC3_BATCH) {
    const chunk = addresses.slice(i, i + MC3_BATCH);

    // Build Multicall3 aggregate3 call with getEthBalance for each address
    const mc3Calls = chunk.map(addr => ({
      target: MULTICALL3,
      allowFailure: true,
      callData: encodeGetEthBalance(addr),
    }));

    try {
      const encoded = encodeMulticall3(mc3Calls);
      const result = await rpc.call('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest']);
      const decoded = decodeMulticall3Result(result, chunk.length);

      for (let j = 0; j < decoded.length; j++) {
        if (decoded[j].success && decoded[j].data !== '0x' + '0'.repeat(64)) {
          const wei = BigInt(decoded[j].data);
          if (wei > 1000000000000000n) { // > 0.001 ETH
            funded.push({ address: chunk[j], ethBalance: wei, ethFormatted: (Number(wei) / 1e18).toFixed(6) });
          }
        }
      }
    } catch (err) {
      // Fallback to JSON-RPC batch if Multicall3 fails
      log.warn(`  mc3 batch failed at ${i}, falling back to RPC batch: ${err.message}`);
      const calls = chunk.map(addr => ({ method: 'eth_getBalance', params: [addr, 'latest'] }));
      try {
        const results = await rpc.batch(calls);
        for (let j = 0; j < chunk.length; j++) {
          const bal = results[j];
          if (bal && !bal.error && typeof bal === 'string') {
            const wei = BigInt(bal);
            if (wei > 1000000000000000n) {
              funded.push({ address: chunk[j], ethBalance: wei, ethFormatted: (Number(wei) / 1e18).toFixed(6) });
            }
          }
        }
      } catch (err2) {
        log.warn(`  RPC batch also failed at ${i}: ${err2.message}`);
      }
    }

    if (i % 2000 === 0 && i > 0) {
      log.info(`  checked ${i}/${addresses.length} | funded: ${funded.length} | ${Math.ceil(i / MC3_BATCH)} mc3 calls`);
    }
  }

  funded.sort((a, b) => Number(b.ethBalance - a.ethBalance));
  const mc3Calls = Math.ceil(addresses.length / MC3_BATCH);
  log.info(`  funded: ${funded.length} contracts with > 0.001 ETH (${mc3Calls} Multicall3 calls vs ${addresses.length} individual calls)`);
  return funded;
}

async function phase3_analyze(rpc, funded) {
  log.info(`PHASE 3: Deep analysis — ${funded.length} funded contracts`);
  const CODE_BATCH = 50;

  // 3a: Batch get code via JSON-RPC batch (eth_getCode can't go through Multicall3)
  log.info('  3a: Fetching bytecode...');
  for (let i = 0; i < funded.length; i += CODE_BATCH) {
    const chunk = funded.slice(i, i + CODE_BATCH);
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

        // Opcode-level proxy/selfdestruct detection
        const opcodes = extractOpcodes(hex);
        chunk[j].isProxy = hex.startsWith('363d3d373d3d3d363d73') || opcodes.has(0xf4);
        chunk[j].hasSelfdestruct = opcodes.has(0xff);

        // EIP-1167 minimal proxy
        if (hex.startsWith('363d3d373d3d3d363d73') && hex.endsWith('5af43d82803e903d91602b57fd5bf3')) {
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

  // 3b: Multicall3 batch storage slot reads for ALL funded contracts
  // 4 slots per contract (owner/slot0, impl, admin, beacon) = 4N reads in N/25 mc3 calls
  log.info('  3b: Reading storage slots via batched RPC...');
  const SLOT_BATCH = 25; // 25 contracts * 4 slots = 100 calls per batch
  const activeContracts = funded.filter(c => !c.destroyed);

  for (let i = 0; i < activeContracts.length; i += SLOT_BATCH) {
    const chunk = activeContracts.slice(i, i + SLOT_BATCH);
    const slotCalls = [];
    for (const c of chunk) {
      slotCalls.push(
        { method: 'eth_getStorageAt', params: [c.address, '0x0', 'latest'] },
        { method: 'eth_getStorageAt', params: [c.address, IMPL_SLOT, 'latest'] },
        { method: 'eth_getStorageAt', params: [c.address, ADMIN_SLOT, 'latest'] },
        { method: 'eth_getStorageAt', params: [c.address, BEACON_SLOT, 'latest'] },
      );
    }

    try {
      const results = await rpc.batch(slotCalls);
      for (let j = 0; j < chunk.length; j++) {
        const slot0 = results[j * 4];
        const impl = results[j * 4 + 1];
        const admin = results[j * 4 + 2];
        const beacon = results[j * 4 + 3];

        chunk[j].slot0Owner = slotToAddress(slot0);
        const implAddr = slotToAddress(impl);
        const adminAddr = slotToAddress(admin);
        const beaconAddr = slotToAddress(beacon);

        if (implAddr) {
          chunk[j].implementation = implAddr;
          chunk[j].isProxy = true;
          chunk[j].proxyType = chunk[j].proxyType || 'eip1967';
        }
        if (adminAddr) chunk[j].admin = adminAddr;
        if (beaconAddr) {
          chunk[j].beacon = beaconAddr;
          chunk[j].proxyType = 'beacon';
        }
      }
    } catch (err) {
      log.warn(`  slot batch failed at ${i}: ${err.message}`);
    }
  }

  const proxyCount = funded.filter(c => c.isProxy).length;
  log.info(`  ${proxyCount} proxies detected, ${Math.ceil(activeContracts.length / SLOT_BATCH)} slot batches`);

  // 3c: Sim unknown selectors on funded non-EOF contracts
  log.info('  3c: Simulating selectors...');
  let simmed = 0;

  for (const c of funded) {
    if (c.destroyed || c.isEOF || !c.selectors || c.selectors.length === 0) continue;

    c.callableSelectors = [];
    const simCalls = c.selectors.slice(0, 30).map(sel => ({
      method: 'eth_estimateGas',
      params: [{ from: OUR_WALLET, to: c.address, data: '0x' + sel }],
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

// Walk bytecode at the opcode level, skipping PUSH data bytes.
function extractOpcodes(hex) {
  const opcodes = new Set();
  let i = 0;
  while (i < hex.length) {
    const op = parseInt(hex.substr(i, 2), 16);
    opcodes.add(op);
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
    i += 2;
  }
  return opcodes;
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
