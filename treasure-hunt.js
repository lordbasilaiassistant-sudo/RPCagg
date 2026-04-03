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
const OUR_WALLET = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

// Known ERC-20s on Base with liquidity
const TOP_TOKENS = [
  { symbol: 'WETH',  addr: '0x4200000000000000000000000000000000000006' },
  { symbol: 'USDbC', addr: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6d' },
  { symbol: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { symbol: 'DAI',   addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  { symbol: 'cbETH', addr: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' },
];

// Known "money extraction" selectors
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
  '39509351': 'increaseAllowance(address,uint256)',
  'f2fde38b': 'transferOwnership(address)',
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
  'b6b55f25': 'deposit(uint256)',
  'd0e30db0': 'deposit()',
  '8da5cb5b': 'owner()',
  '715018a6': 'renounceOwnership()',
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
    const BATCH = 10;

    for (let b = startBlock; b <= endBlock; b += BATCH) {
      const end = Math.min(b + BATCH - 1, endBlock);
      const calls = [];
      for (let i = b; i <= end; i++) {
        calls.push({ method: 'eth_getBlockByNumber', params: [`0x${i.toString(16)}`, true] });
      }

      const blocks = await this.rpc.batch(calls);

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

      if ((b - startBlock) % 100 === 0) {
        log.info(`  scanned blocks ${b}-${end} | ${deployments.length} deploys found`);
      }
    }

    return deployments;
  }

  async resolveAddresses(deployments) {
    const contracts = [];
    const BATCH = 25;

    for (let i = 0; i < deployments.length; i += BATCH) {
      const chunk = deployments.slice(i, i + BATCH);
      const calls = chunk.map(d => ({
        method: 'eth_getTransactionReceipt',
        params: [d.txHash],
      }));

      const receipts = await this.rpc.batch(calls);

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

    return contracts;
  }

  async checkBalances(contracts) {
    const withBalance = [];

    // ETH balances via batch
    const ethCalls = contracts.map(c => ({
      method: 'eth_getBalance',
      params: [c.address, 'latest'],
    }));

    const ethBals = await this.rpc.batchChunked(ethCalls, 50);

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
    const BATCH = 20;

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

        // Check proxy
        chunk[j].isProxy = hex.includes('363d3d373d3d3d363d73') || hex.includes('f4');
        chunk[j].hasSelfdestruct = /ff(?=[0-9a-f]{0,4}$|[0-9a-f]{2}(?:00|5b))/.test(hex) || hex.includes('ff');

        this.scanned++;
      }

      if (i % 100 === 0 && i > 0) {
        log.info(`  analyzed ${i}/${contracts.length} contracts`);
      }
    }

    return contracts;
  }

  async simulateExtractions(contracts) {
    const treasures = [];

    for (const c of contracts) {
      if (c.destroyed) continue;

      const hasValue = c.ethBalance > 0n || (c.tokenBalances && Object.keys(c.tokenBalances).length > 0);

      // Simulate ALL selectors on contracts with value
      if (hasValue) {
        const simResults = await this.simulateAllSelectors(c);
        c.simResults = simResults;

        // Check which extraction functions succeed
        const successfulExtractions = simResults.filter(s =>
          s.success && EXTRACTION_SELECTORS[s.selector]
        );

        if (successfulExtractions.length > 0) {
          c.treasure = true;
          c.profitableActions = successfulExtractions;
          treasures.push(c);

          log.info(`TREASURE: ${c.address}`);
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

          // Run through executor — checks gas cost, calculates profit, executes if EXECUTE=1
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
      }

      // Vectorize every contract (with or without value) for training
      this.vectorizer.vectorize(c);
    }

    return treasures;
  }

  async simulateAllSelectors(contract) {
    const results = [];
    const { address, selectors } = contract;

    // Build simulation calls for every selector
    // Try with no args, then with our address as arg
    const calls = [];
    for (const sel of selectors) {
      // No args
      calls.push({
        selector: sel,
        callData: '0x' + sel,
        name: EXTRACTION_SELECTORS[sel] || `unknown(${sel})`,
      });

      // With our address as single arg (covers withdraw(address), sweep(address), etc)
      if (EXTRACTION_SELECTORS[sel] && EXTRACTION_SELECTORS[sel].includes('address')) {
        calls.push({
          selector: sel,
          callData: '0x' + sel + padAddress(OUR_WALLET),
          name: EXTRACTION_SELECTORS[sel] + ' [with our addr]',
        });
      }
    }

    // Batch simulate via eth_call
    const BATCH = 25;
    for (let i = 0; i < calls.length; i += BATCH) {
      const chunk = calls.slice(i, i + BATCH);
      const rpcCalls = chunk.map(c => ({
        method: 'eth_call',
        params: [{ to: address, data: c.callData, from: OUR_WALLET }, 'latest'],
      }));

      const responses = await this.rpc.batch(rpcCalls);

      for (let j = 0; j < chunk.length; j++) {
        const resp = responses[j];
        const success = resp && !resp.error && typeof resp === 'string';
        results.push({
          selector: chunk[j].selector,
          name: chunk[j].name,
          callData: chunk[j].callData,
          success,
          result: success ? resp : null,
          error: !success ? (resp?.error?.message || resp?.message || 'failed') : null,
        });
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
        isProxy: t.isProxy,
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
