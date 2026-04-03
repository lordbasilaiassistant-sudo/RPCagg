/**
 * Treasure Hunter — Find hidden money in Base's oldest contracts.
 *
 * Strategy:
 * 1. Find the earliest blocks on Base, extract all contract deployments
 * 2. For each contract: check ETH balance, top ERC-20 balances
 * 3. Extract ALL selectors from bytecode
 * 4. Simulate every selector via eth_call to see what's callable
 * 5. Specifically hunt for: withdraw(), transfer(), sweep(), drain(),
 *    claim(), rescue(), emergencyWithdraw(), selfdestruct triggers
 * 6. Report contracts with value + callable extraction functions
 *
 * Usage: node treasure-hunt.js [startBlock] [endBlock]
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, Executor } = require('./src/scanner');
const { Vectorizer } = require('./src/scanner/vectorizer');
const { makeLogger, setLevel } = require('./src/logger');

const log = makeLogger('treasure');
setLevel(process.env.LOG_LEVEL || 'info');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA_DIR = path.join(__dirname, 'data');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZERO_ADDR = '0x' + '0'.repeat(40);
const OUR_WALLET = process.env.EXECUTOR_WALLET || '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

// EIP-1967 storage slots for proxy resolution
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// Known ERC-20s on Base with liquidity
const TOP_TOKENS = [
  { symbol: 'WETH',  addr: '0x4200000000000000000000000000000000000006' },
  { symbol: 'USDbC', addr: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6d' },
  { symbol: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { symbol: 'DAI',   addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  { symbol: 'cbETH', addr: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' },
];

// Known "money extraction" selectors — state-changing functions that move value.
// View functions (owner, renounceOwnership, increaseAllowance, transferOwnership)
// are excluded: they succeed in eth_call but never transfer ETH/tokens.
const EXTRACTION_SELECTORS = {
  '3ccfd60b': 'withdraw()',
  '2e1a7d4d': 'withdraw(uint256)',
  '51cff8d9': 'withdraw(address)',
  'f3fef3a3': 'withdraw(address,uint256)',
  '853828b6': 'withdrawAll()',
  '205c2878': 'withdrawTo(address,uint256)',
  'db006a75': 'withdrawETH(address)',
  '00f714ce': 'withdrawToken(uint256,address)',
  'a9059cbb': 'transfer(address,uint256)',
  '23b872dd': 'transferFrom(address,address,uint256)',
  'e9fad8ee': 'exit()',
  'db2e21bc': 'emergencyWithdraw()',
  '5312ea8e': 'emergencyWithdraw(uint256)',
  '89afcb44': 'burn(address)',
  '42966c68': 'burn(uint256)',
  'be040fb0': 'sweep()',
  '01681a62': 'sweep(address)',
  '6ea056a9': 'sweep(address,uint256)',
  '7df73e27': 'rescue(address)',
  '38e771ab': 'rescue()',
  '00000000': 'receive()/fallback',
};

// ERC-20 balanceOf(address) selector
const BALANCE_OF = 'a9059cbb'.substring(0, 0) + '70a08231';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class TreasureHunter {
  constructor() {
    this.rpc = new RpcClient(RPC);
    this.executor = new Executor(this.rpc);
    this.vectorizer = new Vectorizer(DATA_DIR);
    this.results = [];
    this.scanned = 0;
    this.withValue = 0;
  }

  async run(startBlock, endBlock) {
    log.info(`hunting from block ${startBlock} to ${endBlock}`);

    // Step 1: Find all contract deployments in range
    log.info('step 1: finding contract deployments...');
    const deployments = await this.findDeployments(startBlock, endBlock);
    log.info(`found ${deployments.length} contract deployments`);

    if (deployments.length === 0) {
      log.info('no deployments found in range');
      return [];
    }

    // Step 2: Get contract addresses from receipts
    log.info('step 2: resolving contract addresses...');
    const contracts = await this.resolveAddresses(deployments);
    log.info(`resolved ${contracts.length} contract addresses`);

    // Step 3: Check balances (ETH + tokens)
    log.info('step 3: checking balances...');
    const withBalance = await this.checkBalances(contracts);
    log.info(`${withBalance.length} contracts have value`);

    // Step 4: Analyze ALL contracts (even zero balance — might have withdrawal functions)
    log.info('step 4: full bytecode analysis + selector extraction...');
    const analyzed = await this.analyzeContracts(contracts);

    // Step 5: Simulate extraction calls on contracts with value
    log.info('step 5: simulating extraction calls...');
    const treasures = await this.simulateExtractions(analyzed);

    // Step 6: Write training vectors
    log.info('step 6: writing training vectors...');
    const vectorFile = this.vectorizer.write(`vectors-${startBlock}-${endBlock}.jsonl`);
    const vecStats = this.vectorizer.getStats();
    log.info(`vectors: ${vecStats.totalVectors} (dim=${vecStats.dimensions}) | with value: ${vecStats.valueRate}`);

    // Executor report
    const execReport = this.executor.getReport();
    if (execReport.totalProfitable > 0) {
      log.info(`EXECUTOR: ${execReport.totalProfitable} profitable opportunities found`);
      if (execReport.totalExecuted > 0) {
        log.info(`EXECUTOR: ${execReport.totalExecuted} transactions executed!`);
      }
    }

    // Output results
    this.writeResults(treasures, startBlock, endBlock);
    return treasures;
  }

  async findDeployments(startBlock, endBlock) {
    const deployments = [];
    const BATCH = 50;       // blocks per RPC batch
    const CONCURRENCY = 5;  // parallel batches

    // Build all chunk ranges
    const chunks = [];
    for (let b = startBlock; b <= endBlock; b += BATCH) {
      chunks.push([b, Math.min(b + BATCH - 1, endBlock)]);
    }

    // Process chunks with concurrency
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const wave = chunks.slice(i, i + CONCURRENCY);

      const waveResults = await Promise.all(wave.map(async ([from, to]) => {
        const calls = [];
        for (let b = from; b <= to; b++) {
          calls.push({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, true] });
        }
        return this.rpc.batch(calls);
      }));

      for (const blocks of waveResults) {
        for (const block of blocks) {
          if (!block || block.error || !block.transactions) continue;
          for (const tx of block.transactions) {
            if (tx.to === null && typeof tx === 'object') {
              deployments.push({
                txHash: tx.hash,
                deployer: tx.from,
                blockNumber: parseInt(block.number, 16),
                timestamp: parseInt(block.timestamp, 16),
                value: tx.value,
              });
            }
          }
        }
      }

      const blocksScanned = Math.min((i + CONCURRENCY) * BATCH, endBlock - startBlock);
      if (i % 5 === 0) {
        const pct = ((blocksScanned / (endBlock - startBlock)) * 100).toFixed(1);
        log.info(`  ${pct}% | block ~${startBlock + blocksScanned} | ${deployments.length} deploys`);
      }
    }

    return deployments;
  }

  async resolveAddresses(deployments) {
    const contracts = [];
    const BATCH = 25;       // receipts per batch (smaller to avoid overwhelming RPCs)
    const CONCURRENCY = 2;  // parallel batches (gentler on rate-limited providers)

    const chunks = [];
    for (let i = 0; i < deployments.length; i += BATCH) {
      chunks.push(deployments.slice(i, i + BATCH));
    }

    let batchErrors = 0;
    for (let ci = 0; ci < chunks.length; ci += CONCURRENCY) {
      const wave = chunks.slice(ci, ci + CONCURRENCY);

      const waveResults = await Promise.all(wave.map(async (chunk) => {
        const calls = chunk.map(d => ({
          method: 'eth_getTransactionReceipt',
          params: [d.txHash],
        }));
        try {
          return { chunk, receipts: await this.rpc.batch(calls) };
        } catch (err) {
          batchErrors++;
          log.warn(`receipt batch failed: ${err.message}`);
          return { chunk, receipts: chunk.map(() => null) };
        }
      }));

      for (const { chunk, receipts } of waveResults) {
        for (let j = 0; j < chunk.length; j++) {
          const receipt = receipts[j];
          if (!receipt || receipt.error || !receipt.contractAddress) continue;

          contracts.push({
            ...chunk[j],
            address: receipt.contractAddress,
            gasUsed: parseInt(receipt.gasUsed, 16),
          });
        }
      }

      if ((ci > 0 && ci % 4 === 0) || ci === chunks.length - CONCURRENCY) {
        log.info(`  resolved ${contracts.length}/${deployments.length} addresses (${batchErrors} batch errors)`);
      }
    }

    return contracts;
  }

  async checkBalances(contracts) {
    const withBalance = [];

    // ETH balances via batch
    const ethCalls = contracts.map(c => ({
      method: 'eth_getBalance',
      params: [c.address, 'latest'],
    }));

    const ethBals = await this.rpc.batchChunked(ethCalls, 100);

    for (let i = 0; i < contracts.length; i++) {
      const bal = ethBals[i];
      if (bal && !bal.error) {
        contracts[i].ethBalance = BigInt(bal);
        contracts[i].ethBalanceFormatted = formatEth(BigInt(bal));
      } else {
        contracts[i].ethBalance = 0n;
        contracts[i].ethBalanceFormatted = '0';
      }
    }

    // ERC-20 balances via Multicall3
    for (const token of TOP_TOKENS) {
      const mc3Calls = contracts.map(c => ({
        target: token.addr,
        allowFailure: true,
        callData: '0x' + BALANCE_OF + padAddress(c.address),
      }));

      // Chunk multicall into batches of 100
      for (let i = 0; i < mc3Calls.length; i += 100) {
        const chunk = mc3Calls.slice(i, i + 100);
        const encoded = encodeMulticall3(chunk);

        try {
          const result = await this.rpc.call('eth_call', [{
            to: MULTICALL3,
            data: encoded,
          }, 'latest']);

          const decoded = decodeMulticall3Result(result, chunk.length);
          for (let j = 0; j < decoded.length; j++) {
            const ci = i + j;
            if (ci >= contracts.length) break;
            if (decoded[j].success && decoded[j].data !== '0x' + '0'.repeat(64)) {
              const bal = BigInt('0x' + decoded[j].data.replace('0x', ''));
              if (bal > 0n) {
                if (!contracts[ci].tokenBalances) contracts[ci].tokenBalances = {};
                contracts[ci].tokenBalances[token.symbol] = bal.toString();
              }
            }
          }
        } catch (err) {
          log.debug(`multicall failed for ${token.symbol}: ${err.message}`);
        }
      }
    }

    // Filter contracts with any value
    for (const c of contracts) {
      const hasEth = c.ethBalance > 0n;
      const hasTokens = c.tokenBalances && Object.keys(c.tokenBalances).length > 0;
      if (hasEth || hasTokens) {
        withBalance.push(c);
        this.withValue++;
      }
    }

    return withBalance;
  }

  async analyzeContracts(contracts) {
    const BATCH = 50;

    for (let i = 0; i < contracts.length; i += BATCH) {
      const chunk = contracts.slice(i, i + BATCH);
      const calls = chunk.map(c => ({
        method: 'eth_getCode',
        params: [c.address, 'latest'],
      }));

      const codes = await this.rpc.batch(calls);

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

        // Extract ALL selectors
        const selectors = extractSelectors(hex);
        chunk[j].selectors = selectors;

        // Classify known extraction selectors
        chunk[j].extractionFunctions = [];
        for (const sel of selectors) {
          if (EXTRACTION_SELECTORS[sel]) {
            chunk[j].extractionFunctions.push({
              selector: sel,
              name: EXTRACTION_SELECTORS[sel],
            });
          }
        }

        // Check proxy and selfdestruct via opcode-level disassembly.
        // Naive string matching (includes('f4')) matches data bytes inside PUSH
        // operands, producing ~71% false positive rate. Walk opcodes properly.
        const opcodes = extractOpcodes(hex);
        chunk[j].isProxy = hex.includes('363d3d373d3d3d363d73') || opcodes.has(0xf4); // DELEGATECALL
        chunk[j].hasSelfdestruct = opcodes.has(0xff); // SELFDESTRUCT

        // EIP-1167 minimal proxy: extract implementation from bytecode
        if (hex.startsWith('363d3d373d3d3d363d73') && hex.endsWith('5af43d82803e903d91602b57fd5bf3')) {
          chunk[j].proxyType = 'eip1167-minimal';
          chunk[j].implementation = '0x' + hex.substring(20, 60);
        }

        this.scanned++;
      }

      // Resolve EIP-1967 proxy targets for contracts flagged as proxies
      const proxies = chunk.filter(c => c.isProxy && !c.implementation);
      if (proxies.length > 0) {
        const slotCalls = [];
        for (const p of proxies) {
          slotCalls.push(
            { method: 'eth_getStorageAt', params: [p.address, IMPL_SLOT, 'latest'] },
            { method: 'eth_getStorageAt', params: [p.address, ADMIN_SLOT, 'latest'] },
            { method: 'eth_getStorageAt', params: [p.address, BEACON_SLOT, 'latest'] },
          );
        }
        try {
          const slotResults = await this.rpc.batch(slotCalls);
          for (let k = 0; k < proxies.length; k++) {
            const implRaw = slotResults[k * 3];
            const adminRaw = slotResults[k * 3 + 1];
            const beaconRaw = slotResults[k * 3 + 2];
            const impl = slotToAddress(implRaw);
            const admin = slotToAddress(adminRaw);
            const beacon = slotToAddress(beaconRaw);
            if (impl) {
              proxies[k].implementation = impl;
              proxies[k].proxyType = 'eip1967';
            }
            if (admin) proxies[k].admin = admin;
            if (beacon) {
              proxies[k].beacon = beacon;
              proxies[k].proxyType = 'beacon';
            }
            if (!proxies[k].proxyType) proxies[k].proxyType = 'delegatecall';
          }
        } catch (err) {
          log.debug(`proxy slot resolution failed: ${err.message}`);
        }
      }

      if (i % 100 === 0 && i > 0) {
        log.info(`  analyzed ${i}/${contracts.length} contracts`);
      }
    }

    return contracts;
  }

  async simulateExtractions(contracts) {
    const treasures = [];
    const MIN_ETH_FOR_DEEP_SIM = BigInt('10000000000000000'); // 0.01 ETH

    for (const c of contracts) {
      if (c.destroyed) continue;

      const hasValue = c.ethBalance > 0n || (c.tokenBalances && Object.keys(c.tokenBalances).length > 0);
      const highValue = c.ethBalance >= MIN_ETH_FOR_DEEP_SIM;

      // Simulate ALL selectors on contracts with value
      if (hasValue) {
        let simResults;
        try {
          simResults = await this.simulateAllSelectors(c);
        } catch (err) {
          log.warn(`sim failed for ${c.address}: ${err.message}`);
          this.vectorizer.vectorize(c);
          continue;
        }
        c.simResults = simResults;

        // Check which KNOWN extraction functions succeed
        const successfulExtractions = simResults.filter(s =>
          s.success && EXTRACTION_SELECTORS[s.selector]
        );

        // === UNKNOWN SELECTOR EXPLORER ===
        // For contracts with ETH >= 0.01, find ALL unknown selectors that succeed.
        // Then estimate gas to filter out view functions (gas <= 26K).
        // What remains are state-changing callable functions on funded contracts
        // that we have NO hardcoded rule for — pure emergent discovery.
        const unknownCallables = simResults.filter(s =>
          s.success && !EXTRACTION_SELECTORS[s.selector]
        );

        if (highValue && unknownCallables.length > 0) {
          // Deduplicate by selector (keep first successful arg pattern)
          const seen = new Set();
          const uniqueUnknowns = unknownCallables.filter(s => {
            const key = s.selector + ':' + s.argPattern;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          // Estimate gas on each unknown callable
          const withGas = await this.estimateGasForCallables(c.address, uniqueUnknowns);

          // Filter: gas > 26K = state-changing (not a view function)
          const stateChanging = withGas.filter(s => s.gasEstimate && s.gasEstimate > 26000);

          if (stateChanging.length > 0) {
            c.unknownCallables = stateChanging.map(s => ({
              selector: s.selector,
              argPattern: s.argPattern,
              gasEstimate: s.gasEstimate,
              result: s.result?.substring(0, 130),
            }));

            log.info(`DISCOVERY: ${c.address} (${c.ethBalanceFormatted})`);
            log.info(`  ${stateChanging.length} unknown state-changing callable(s):`);
            for (const s of stateChanging) {
              log.info(`    0x${s.selector} [${s.argPattern}] gas=${s.gasEstimate}`);
            }
          }
        }

        // Flag as treasure if known extraction functions OR unknown callables found
        const hasKnownExtractions = successfulExtractions.length > 0;
        const hasUnknownCallables = c.unknownCallables && c.unknownCallables.length > 0;

        if (hasKnownExtractions || hasUnknownCallables) {
          c.treasure = true;
          c.profitableActions = successfulExtractions;
          treasures.push(c);

          if (hasKnownExtractions) {
            log.info(`TREASURE (known): ${c.address}`);
            log.info(`  ETH: ${c.ethBalanceFormatted}`);
            if (c.tokenBalances) {
              for (const [sym, bal] of Object.entries(c.tokenBalances)) {
                log.info(`  ${sym}: ${bal}`);
              }
            }
            log.info(`  Callable extraction functions:`);
            for (const s of successfulExtractions) {
              log.info(`    ${EXTRACTION_SELECTORS[s.selector]} (${s.selector}) -> ${s.result?.substring(0, 66) || 'ok'}`);
            }

            // Run through executor for known extractions
            for (const s of successfulExtractions) {
              const execResult = await this.executor.evaluate({
                target: c.address,
                callData: s.callData,
                fnName: s.name,
                contractEthBalance: c.ethBalance,
                contractTokenBalances: c.tokenBalances,
              });

              if (execResult.profitable) {
                log.info(`*** PROFITABLE: ${execResult.profitEth.toFixed(6)} ETH from ${c.address} via ${s.name}`);
                if (execResult.executed) {
                  log.info(`*** TX SENT: ${execResult.txHash}`);
                }
              }
            }
          }

          if (hasUnknownCallables) {
            log.info(`TREASURE (unknown): ${c.address} — ${c.unknownCallables.length} unknown callable(s) on contract with ${c.ethBalanceFormatted}`);
          }
        }
      }

      // Vectorize every contract (with or without value) for training.
      // Now includes unknownCallables data for the neural net to learn from.
      this.vectorizer.vectorize(c);
    }

    return treasures;
  }

  async simulateAllSelectors(contract) {
    const results = [];
    const { address, selectors } = contract;

    // Build simulation calls for EVERY selector — not just known ones.
    // Try multiple arg patterns: no args, our address, uint256 max, zero args.
    // The goal is emergent discovery: find callable functions we never programmed.
    const calls = [];
    for (const sel of selectors) {
      const known = EXTRACTION_SELECTORS[sel];

      // No args (covers 0-arg functions)
      calls.push({
        selector: sel,
        callData: '0x' + sel,
        name: known || `unknown(${sel})`,
        argPattern: 'no_args',
      });

      // With our address as single arg (covers fn(address) patterns)
      calls.push({
        selector: sel,
        callData: '0x' + sel + padAddress(OUR_WALLET),
        name: (known || `unknown(${sel})`) + ' [addr]',
        argPattern: 'address',
      });

      // With uint256 max as single arg (covers fn(uint256) like withdraw(amount))
      calls.push({
        selector: sel,
        callData: '0x' + sel + 'f'.repeat(64),
        name: (known || `unknown(${sel})`) + ' [uint_max]',
        argPattern: 'uint256_max',
      });
    }

    // Batch simulate via eth_call — wrapped in try/catch per batch
    const BATCH = 25;
    for (let i = 0; i < calls.length; i += BATCH) {
      const chunk = calls.slice(i, i + BATCH);
      const rpcCalls = chunk.map(c => ({
        method: 'eth_call',
        params: [{ to: address, data: c.callData, from: OUR_WALLET }, 'latest'],
      }));

      let responses;
      try {
        responses = await this.rpc.batch(rpcCalls);
      } catch (err) {
        for (const c of chunk) {
          results.push({ selector: c.selector, name: c.name, callData: c.callData, argPattern: c.argPattern, success: false, result: null, error: err.message });
        }
        continue;
      }

      for (let j = 0; j < chunk.length; j++) {
        const resp = responses[j];
        const success = resp && !resp.error && typeof resp === 'string';
        results.push({
          selector: chunk[j].selector,
          name: chunk[j].name,
          callData: chunk[j].callData,
          argPattern: chunk[j].argPattern,
          success,
          result: success ? resp : null,
          error: !success ? (resp?.error?.message || resp?.message || 'failed') : null,
        });
      }
    }

    return results;
  }

  // Estimate gas for successful unknown selectors to distinguish state-changing
  // functions (gas > 26K) from view/pure functions (gas ~21K).
  async estimateGasForCallables(address, callables) {
    const results = [];
    const BATCH = 10;

    for (let i = 0; i < callables.length; i += BATCH) {
      const chunk = callables.slice(i, i + BATCH);
      const rpcCalls = chunk.map(c => ({
        method: 'eth_estimateGas',
        params: [{ from: OUR_WALLET, to: address, data: c.callData, value: '0x0' }],
      }));

      let responses;
      try {
        responses = await this.rpc.batch(rpcCalls);
      } catch (err) {
        for (const c of chunk) {
          results.push({ ...c, gasEstimate: null, gasError: err.message });
        }
        continue;
      }

      for (let j = 0; j < chunk.length; j++) {
        const resp = responses[j];
        if (resp && !resp.error && typeof resp === 'string') {
          results.push({ ...chunk[j], gasEstimate: parseInt(resp, 16) });
        } else {
          results.push({ ...chunk[j], gasEstimate: null, gasError: resp?.error?.message || 'estimate failed' });
        }
      }
    }

    return results;
  }

  writeResults(treasures, startBlock, endBlock) {
    const outFile = path.join(DATA_DIR, `treasure-${startBlock}-${endBlock}.json`);

    const report = {
      scan: {
        startBlock,
        endBlock,
        scannedAt: new Date().toISOString(),
        contractsScanned: this.scanned,
        contractsWithValue: this.withValue,
        treasuresFound: treasures.length,
      },
      treasures: treasures.map(t => ({
        address: t.address,
        deployer: t.deployer,
        blockNumber: t.blockNumber,
        timestamp: t.timestamp,
        age: `block ${t.blockNumber}`,
        ethBalance: t.ethBalanceFormatted,
        tokenBalances: t.tokenBalances || {},
        codeSize: t.codeSize,
        totalSelectors: t.selectors.length,
        extractionFunctions: t.extractionFunctions,
        profitableActions: t.profitableActions?.map(a => ({
          selector: a.selector,
          name: a.name,
          callData: a.callData,
          result: a.result?.substring(0, 130),
        })),
        // Unknown callable selectors — state-changing functions we have no rule for.
        // These are the emergent discoveries for the neural net to learn from.
        unknownCallables: t.unknownCallables || [],
        discoveryType: t.unknownCallables?.length > 0
          ? (t.profitableActions?.length > 0 ? 'known+unknown' : 'unknown_only')
          : 'known',
        isProxy: t.isProxy,
        proxyType: t.proxyType || null,
        implementation: t.implementation || null,
        hasSelfdestruct: t.hasSelfdestruct,
      })),
      allContracts: undefined, // set below for full report
    };

    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    log.info(`results written to ${outFile}`);

    // Also write a full JSONL of all analyzed contracts
    const allFile = path.join(DATA_DIR, `contracts-${startBlock}-${endBlock}.jsonl`);
    const stream = fs.createWriteStream(allFile);
    // We don't have all contracts here, just treasures - skip for now

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('  TREASURE HUNT REPORT');
    console.log('='.repeat(60));
    console.log(`  Range: ${startBlock} - ${endBlock}`);
    console.log(`  Contracts scanned: ${this.scanned}`);
    console.log(`  Contracts with value: ${this.withValue}`);
    console.log(`  TREASURES FOUND: ${treasures.length}`);

    if (treasures.length > 0) {
      console.log('\n  --- TREASURES ---');
      for (const t of treasures) {
        console.log(`\n  ${t.address}`);
        console.log(`    Deployed: block ${t.blockNumber} by ${t.deployer}`);
        console.log(`    ETH: ${t.ethBalanceFormatted}`);
        if (t.tokenBalances) {
          for (const [sym, bal] of Object.entries(t.tokenBalances)) {
            console.log(`    ${sym}: ${bal}`);
          }
        }
        console.log(`    Selectors: ${t.selectors.length} | Extraction fns: ${t.extractionFunctions.length}`);
        if (t.profitableActions) {
          for (const a of t.profitableActions) {
            console.log(`    -> ${a.name} CALLABLE`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(60));
  }
}

// ─── Helpers ──────────────────────────────────────

function extractSelectors(hex) {
  const selectors = new Set();
  // PUSH4 <sel> EQ pattern
  const regex = /63([0-9a-f]{8})14/g;
  let match;
  while ((match = regex.exec(hex)) !== null) {
    selectors.add(match[1]);
  }
  return [...selectors];
}

// Walk bytecode at the opcode level, skipping PUSH data bytes.
// Returns a Set of opcode values that appear as actual instructions (not data).
function extractOpcodes(hex) {
  const opcodes = new Set();
  let i = 0;
  while (i < hex.length) {
    const op = parseInt(hex.substr(i, 2), 16);
    opcodes.add(op);
    // PUSHn opcodes (0x60-0x7f): skip the next n bytes of inline data
    if (op >= 0x60 && op <= 0x7f) {
      i += (op - 0x5f) * 2;
    }
    i += 2;
  }
  return opcodes;
}

function slotToAddress(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const hex = raw.replace('0x', '').padStart(64, '0');
  const addr = '0x' + hex.slice(-40);
  if (addr === ZERO_ADDR) return null;
  return addr;
}

function padAddress(addr) {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function formatEth(wei) {
  if (wei === 0n) return '0';
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6) + ' ETH';
}

// Multicall3 encoding (aggregate3)
function encodeMulticall3(calls) {
  // aggregate3((address target, bool allowFailure, bytes callData)[])
  // Selector: 0x82ad56cb
  const selector = '82ad56cb';

  // ABI encode the tuple array
  let encoded = selector;

  // Offset to array data (32 bytes)
  encoded += '0000000000000000000000000000000000000000000000000000000000000020';
  // Array length
  encoded += BigInt(calls.length).toString(16).padStart(64, '0');

  // Each element is a tuple (address, bool, bytes)
  // First, compute offsets for each element
  const elemOffsets = [];
  let currentOffset = calls.length * 32; // past the offset array

  for (const call of calls) {
    elemOffsets.push(currentOffset);
    // Each struct: address (32) + allowFailure (32) + bytes offset (32) + bytes length (32) + bytes data (ceil32)
    const dataLen = (call.callData.replace('0x', '').length / 2);
    const paddedLen = Math.ceil(dataLen / 32) * 32;
    currentOffset += 32 + 32 + 32 + 32 + paddedLen;
  }

  // Write offsets
  for (const offset of elemOffsets) {
    encoded += BigInt(offset).toString(16).padStart(64, '0');
  }

  // Write each struct
  for (const call of calls) {
    // target address
    encoded += call.target.toLowerCase().replace('0x', '').padStart(64, '0');
    // allowFailure
    encoded += call.allowFailure ? '0000000000000000000000000000000000000000000000000000000000000001' : '0000000000000000000000000000000000000000000000000000000000000000';
    // bytes offset (always 96 = 0x60, pointing past the 3 fixed fields)
    encoded += '0000000000000000000000000000000000000000000000000000000000000060';
    // bytes length
    const data = call.callData.replace('0x', '');
    const dataLen = data.length / 2;
    encoded += BigInt(dataLen).toString(16).padStart(64, '0');
    // bytes data (padded to 32)
    const paddedLen = Math.ceil(dataLen / 32) * 32;
    encoded += data.padEnd(paddedLen * 2, '0');
  }

  return '0x' + encoded;
}

function decodeMulticall3Result(result, count) {
  const hex = result.replace('0x', '');
  const decoded = [];

  // Result: (bool success, bytes returnData)[]
  // Skip offset (32 bytes) + array length (32 bytes)
  let pos = 128; // 64 chars for offset + 64 chars for length

  // Read offsets
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(parseInt(hex.substring(pos, pos + 64), 16) * 2); // byte offset to char offset
    pos += 64;
  }

  // Read each result
  for (let i = 0; i < count; i++) {
    const base = 64 + offsets[i]; // account for initial offset word
    const success = parseInt(hex.substring(base, base + 64), 16) === 1;
    const dataOffset = parseInt(hex.substring(base + 64, base + 128), 16) * 2;
    const dataStart = base + dataOffset;
    const dataLen = parseInt(hex.substring(dataStart, dataStart + 64), 16);
    const data = '0x' + hex.substring(dataStart + 64, dataStart + 64 + dataLen * 2);

    decoded.push({ success, data });
  }

  return decoded;
}

// ─── Main ──────────────────────────────────────

async function main() {
  const hunter = new TreasureHunter();

  // Check aggregator
  const health = await hunter.rpc.checkHealth();
  if (health.status === 'unreachable') {
    console.error('Aggregator not running — start it with: npm start');
    process.exit(1);
  }
  log.info(`aggregator: ${health.availableProviders} providers`);

  // Get chain head
  const head = parseInt(await hunter.rpc.call('eth_blockNumber'), 16);
  log.info(`chain head: ${head}`);

  // Parse args or default to earliest blocks
  const startBlock = parseInt(process.argv[2] || '1', 10);
  const endBlock = parseInt(process.argv[3] || '10000', 10);

  await hunter.run(startBlock, endBlock);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
