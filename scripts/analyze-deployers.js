/**
 * Deployer Wallet Analysis — Chain Analyst Task #9
 *
 * Analyzes all unique deployer wallets from our scanned contracts.
 * Uses Multicall3 to batch-query balances and nonces.
 * Identifies: serial deployers, dormant wallets, dead wallets with funded contracts.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const RPC_URL = 'http://127.0.0.1:8545';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BATCH_SIZE = 100; // safe for free RPCs

// ---- RPC helpers ----

function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(RPC_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(`RPC error: ${JSON.stringify(parsed.error)}`));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ABI encode aggregate3 call
// aggregate3((address target, bool allowFailure, bytes callData)[])
// selector: 0x82ad56cb
function encodeAggregate3(calls) {
  // Each call: { target, allowFailure, callData }
  // Encoding: selector + offset to array + array length + array elements
  // Each element: offset to struct, then struct = (address, bool, offset to bytes, bytes length, bytes data)
  // This is complex dynamic ABI encoding — let's build it step by step

  const selector = '82ad56cb';

  // The parameter is a dynamic array of tuples
  // Layout: offset_to_array(32) | array_length(32) | [offsets_to_each_tuple...] | [tuple_data...]

  const arrayLen = calls.length;

  // Each tuple is (address, bool, bytes) where bytes is dynamic
  // In the array, we store offsets to each tuple
  // Each tuple: address(32) + bool(32) + offset_to_bytes(32) + bytes_len(32) + bytes_padded

  let parts = [];

  // Offset to array data (always 0x20 = 32)
  parts.push(pad32(32));
  // Array length
  parts.push(pad32(arrayLen));

  // Calculate offsets to each tuple
  // After array length, we have arrayLen offset slots (each 32 bytes)
  // Then the actual tuple data follows
  let tupleDataOffset = arrayLen * 32;
  let tupleOffsets = [];
  let tupleDatas = [];

  for (const call of calls) {
    tupleOffsets.push(pad32(tupleDataOffset));

    const callDataBytes = call.callData.replace('0x', '');
    const callDataLen = callDataBytes.length / 2;
    const callDataPadded = callDataBytes.padEnd(Math.ceil(callDataLen / 32) * 64, '0');

    // Tuple: address(32) + bool(32) + offset_to_bytes(32) + bytes_len(32) + bytes_data(padded)
    const tupleData =
      pad32Address(call.target) +
      pad32(call.allowFailure ? 1 : 0) +
      pad32(96) + // offset to bytes is always 96 (3 * 32) from start of tuple
      pad32(callDataLen) +
      callDataPadded;

    tupleDatas.push(tupleData);
    tupleDataOffset += tupleData.length / 2;
  }

  // Assemble: selector + offset + length + tuple_offsets + tuple_datas
  return '0x' + selector + parts.join('') + tupleOffsets.join('') + tupleDatas.join('');
}

function pad32(num) {
  return BigInt(num).toString(16).padStart(64, '0');
}

function pad32Address(addr) {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

function decodeAggregate3Result(hexData) {
  // Returns: (bool success, bytes returnData)[]
  const data = hexData.replace('0x', '');

  // Offset to array
  const arrayOffset = parseInt(data.slice(0, 64), 16) * 2;
  // Array length
  const arrayLen = parseInt(data.slice(arrayOffset, arrayOffset + 64), 16);

  const results = [];
  const offsetsStart = arrayOffset + 64;

  for (let i = 0; i < arrayLen; i++) {
    const tupleOffset = parseInt(data.slice(offsetsStart + i * 64, offsetsStart + (i + 1) * 64), 16) * 2 + arrayOffset + 64;

    const success = parseInt(data.slice(tupleOffset, tupleOffset + 64), 16) === 1;
    const bytesOffset = parseInt(data.slice(tupleOffset + 64, tupleOffset + 128), 16) * 2;
    const bytesLen = parseInt(data.slice(tupleOffset + bytesOffset, tupleOffset + bytesOffset + 64), 16);
    const returnData = '0x' + data.slice(tupleOffset + bytesOffset + 64, tupleOffset + bytesOffset + 64 + bytesLen * 2);

    results.push({ success, returnData });
  }

  return results;
}

// JSON-RPC batch with timeout
async function batchRpc(requests, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(requests);
    const url = new URL(RPC_URL);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

// ---- Main analysis ----

async function main() {
  console.log('=== Deployer Wallet Analysis ===\n');

  // Load vectors (has ALL 2265 contracts with deployers)
  const vectorsPath = path.join(__dirname, '..', 'data', 'vectors-1950000-2050000.jsonl');
  const vectorLines = fs.readFileSync(vectorsPath, 'utf-8').trim().split('\n');
  const contracts = vectorLines.map(l => JSON.parse(l));

  console.log(`Loaded ${contracts.length} contracts`);

  // Load treasure data for enrichment
  const treasurePath = path.join(__dirname, '..', 'data', 'treasure-1950000-2050000.json');
  const treasureData = JSON.parse(fs.readFileSync(treasurePath, 'utf-8'));
  const treasureMap = {};
  for (const t of treasureData.treasures) {
    treasureMap[t.address.toLowerCase()] = t;
  }

  // Group contracts by deployer
  const deployerContracts = {};
  for (const c of contracts) {
    const deployer = c.deployer.toLowerCase();
    if (!deployerContracts[deployer]) {
      deployerContracts[deployer] = [];
    }
    deployerContracts[deployer].push({
      address: c.address.toLowerCase(),
      block: c.block,
      hasValue: c.labels?.hasValue || false,
      ethValue: c.labels?.ethValue || 0,
      isTreasure: c.labels?.treasure || false,
      proxyType: c.labels?.proxyType || 'none'
    });
  }

  const uniqueDeployers = Object.keys(deployerContracts);
  console.log(`Found ${uniqueDeployers.length} unique deployers\n`);

  // Fetch balances and nonces via JSON-RPC batch (through aggregator)
  // Use small batches of 20 deployers (40 RPC calls) to avoid aggregator choking
  console.log('Fetching deployer balances and nonces via RPC batch...');

  const deployerData = {};
  const QUERY_BATCH = 20;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < uniqueDeployers.length; i += QUERY_BATCH) {
    const batch = uniqueDeployers.slice(i, i + QUERY_BATCH);
    const requests = [];

    for (const deployer of batch) {
      requests.push({
        jsonrpc: '2.0',
        id: `bal_${deployer}`,
        method: 'eth_getBalance',
        params: [deployer, 'latest']
      });
      requests.push({
        jsonrpc: '2.0',
        id: `nonce_${deployer}`,
        method: 'eth_getTransactionCount',
        params: [deployer, 'latest']
      });
    }

    try {
      const responses = await batchRpc(requests);
      const responseMap = {};
      for (const r of responses) {
        if (r && r.id) responseMap[r.id] = r.result;
      }

      for (const deployer of batch) {
        const balHex = responseMap[`bal_${deployer}`] || '0x0';
        const nonceHex = responseMap[`nonce_${deployer}`] || '0x0';
        deployerData[deployer] = {
          balance: BigInt(balHex),
          balanceEth: Number(BigInt(balHex)) / 1e18,
          nonce: parseInt(nonceHex, 16),
        };
        successCount++;
      }
    } catch (err) {
      // Fallback: individual calls
      for (const deployer of batch) {
        try {
          const balHex = await rpcCall('eth_getBalance', [deployer, 'latest']);
          const nonceHex = await rpcCall('eth_getTransactionCount', [deployer, 'latest']);
          deployerData[deployer] = {
            balance: BigInt(balHex),
            balanceEth: Number(BigInt(balHex)) / 1e18,
            nonce: parseInt(nonceHex, 16),
          };
          successCount++;
        } catch (e2) {
          deployerData[deployer] = { balance: 0n, balanceEth: 0, nonce: 0, error: e2.message };
          failCount++;
        }
      }
    }

    const done = Math.min(i + QUERY_BATCH, uniqueDeployers.length);
    if (done % 100 === 0 || done >= uniqueDeployers.length) {
      console.log(`  ${done}/${uniqueDeployers.length} deployers queried (${failCount} failures)`);
    }
  }

  console.log('\nBuilding analysis...\n');

  // Build deployer profiles
  const deployers = [];

  for (const [deployer, contractList] of Object.entries(deployerContracts)) {
    const data = deployerData[deployer] || { balanceEth: 0, nonce: 0 };

    // Calculate total ETH in deployed contracts
    let totalContractEth = 0;
    let treasureContracts = [];
    let fundedContracts = [];

    for (const c of contractList) {
      const treasure = treasureMap[c.address];
      if (treasure) {
        const ethBal = parseFloat(treasure.ethBalance) || 0;
        totalContractEth += ethBal;
        if (ethBal > 0) fundedContracts.push({ address: c.address, eth: ethBal });
        treasureContracts.push(c.address);
      }
      if (c.ethValue > 0) {
        totalContractEth += c.ethValue;
        if (!fundedContracts.find(f => f.address === c.address)) {
          fundedContracts.push({ address: c.address, eth: c.ethValue });
        }
      }
    }

    // Determine deployer timestamps from block numbers
    const blocks = contractList.map(c => c.block);
    const minBlock = Math.min(...blocks);
    const maxBlock = Math.max(...blocks);

    // Activity classification
    const isDead = data.balanceEth === 0 && data.nonce < 10;
    const isDormant = data.balanceEth < 0.001 && data.nonce < 50;
    const isSerialDeployer = contractList.length >= 3;
    const isFactory = contractList.length >= 10;
    const hasAbandoned = isDead && totalContractEth > 0;

    let classification = 'normal';
    if (isFactory) classification = 'factory';
    else if (isSerialDeployer) classification = 'serial_deployer';
    if (isDead) classification = hasAbandoned ? 'dead_with_value' : 'dead';
    else if (isDormant) classification = totalContractEth > 0 ? 'dormant_with_value' : 'dormant';

    deployers.push({
      address: deployer,
      contractCount: contractList.length,
      contracts: contractList.map(c => c.address),
      balanceEth: data.balanceEth,
      nonce: data.nonce,
      blockRange: { min: minBlock, max: maxBlock },
      totalContractEth,
      fundedContracts,
      treasureContracts,
      proxyContracts: contractList.filter(c => c.proxyType !== 'none').length,
      classification,
      isDead,
      isDormant,
      isSerialDeployer,
      isFactory,
      hasAbandonedValue: hasAbandoned
    });
  }

  // Sort by interest: dead with value first, then serial deployers, then by contract count
  deployers.sort((a, b) => {
    if (a.hasAbandonedValue && !b.hasAbandonedValue) return -1;
    if (!a.hasAbandonedValue && b.hasAbandonedValue) return 1;
    if (a.totalContractEth !== b.totalContractEth) return b.totalContractEth - a.totalContractEth;
    return b.contractCount - a.contractCount;
  });

  // Build summary statistics
  const stats = {
    totalDeployers: deployers.length,
    totalContracts: contracts.length,
    classifications: {},
    serialDeployers: deployers.filter(d => d.isSerialDeployer).length,
    factories: deployers.filter(d => d.isFactory).length,
    deadWallets: deployers.filter(d => d.isDead).length,
    dormantWallets: deployers.filter(d => d.isDormant).length,
    deadWithValue: deployers.filter(d => d.hasAbandonedValue).length,
    totalDeployerEth: deployers.reduce((s, d) => s + d.balanceEth, 0),
    totalContractEth: deployers.reduce((s, d) => s + d.totalContractEth, 0),
    avgNonce: Math.round(deployers.reduce((s, d) => s + d.nonce, 0) / deployers.length),
    medianNonce: deployers.map(d => d.nonce).sort((a, b) => a - b)[Math.floor(deployers.length / 2)],
    topDeployersByCount: deployers
      .filter(d => d.contractCount > 1)
      .sort((a, b) => b.contractCount - a.contractCount)
      .slice(0, 20)
      .map(d => ({ address: d.address, count: d.contractCount, balanceEth: d.balanceEth, nonce: d.nonce })),
    highValueTargets: deployers
      .filter(d => d.hasAbandonedValue || (d.isDormant && d.totalContractEth > 0))
      .map(d => ({
        deployer: d.address,
        deployerBalanceEth: d.balanceEth,
        nonce: d.nonce,
        classification: d.classification,
        contractCount: d.contractCount,
        totalContractEth: d.totalContractEth,
        fundedContracts: d.fundedContracts
      }))
  };

  // Count classifications
  for (const d of deployers) {
    stats.classifications[d.classification] = (stats.classifications[d.classification] || 0) + 1;
  }

  // Nonce distribution
  const nonceBuckets = { '0': 0, '1-5': 0, '6-20': 0, '21-100': 0, '101-500': 0, '501+': 0 };
  for (const d of deployers) {
    if (d.nonce === 0) nonceBuckets['0']++;
    else if (d.nonce <= 5) nonceBuckets['1-5']++;
    else if (d.nonce <= 20) nonceBuckets['6-20']++;
    else if (d.nonce <= 100) nonceBuckets['21-100']++;
    else if (d.nonce <= 500) nonceBuckets['101-500']++;
    else nonceBuckets['501+']++;
  }
  stats.nonceDistribution = nonceBuckets;

  // Balance distribution
  const balBuckets = { '0 ETH': 0, '<0.001 ETH': 0, '0.001-0.01': 0, '0.01-0.1': 0, '0.1-1': 0, '1-10': 0, '10+': 0 };
  for (const d of deployers) {
    if (d.balanceEth === 0) balBuckets['0 ETH']++;
    else if (d.balanceEth < 0.001) balBuckets['<0.001 ETH']++;
    else if (d.balanceEth < 0.01) balBuckets['0.001-0.01']++;
    else if (d.balanceEth < 0.1) balBuckets['0.01-0.1']++;
    else if (d.balanceEth < 1) balBuckets['0.1-1']++;
    else if (d.balanceEth < 10) balBuckets['1-10']++;
    else balBuckets['10+']++;
  }
  stats.balanceDistribution = balBuckets;

  // Output
  const output = {
    generatedAt: new Date().toISOString(),
    scanRange: { startBlock: 1950000, endBlock: 2050000 },
    stats,
    deployers
  };

  const outPath = path.join(__dirname, '..', 'data', 'deployer-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  , 2));

  console.log(`Results written to ${outPath}\n`);

  // Print summary
  console.log('=== SUMMARY ===');
  console.log(`Total deployers: ${stats.totalDeployers}`);
  console.log(`Total contracts: ${stats.totalContracts}`);
  console.log(`Avg contracts per deployer: ${(stats.totalContracts / stats.totalDeployers).toFixed(2)}`);
  console.log(`\nClassifications:`);
  for (const [cls, count] of Object.entries(stats.classifications)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log(`\nNonce distribution:`);
  for (const [bucket, count] of Object.entries(stats.nonceDistribution)) {
    console.log(`  ${bucket}: ${count}`);
  }
  console.log(`\nBalance distribution:`);
  for (const [bucket, count] of Object.entries(stats.balanceDistribution)) {
    console.log(`  ${bucket}: ${count}`);
  }
  console.log(`\nSerial deployers (3+ contracts): ${stats.serialDeployers}`);
  console.log(`Factory deployers (10+ contracts): ${stats.factories}`);
  console.log(`Dead wallets (0 ETH, <10 nonce): ${stats.deadWallets}`);
  console.log(`Dormant wallets (<0.001 ETH, <50 nonce): ${stats.dormantWallets}`);

  console.log(`\n=== HIGH VALUE TARGETS ===`);
  console.log(`Dead/dormant deployers with funded contracts: ${stats.highValueTargets.length}`);
  for (const t of stats.highValueTargets) {
    console.log(`\n  Deployer: ${t.deployer}`);
    console.log(`    Balance: ${t.deployerBalanceEth.toFixed(6)} ETH | Nonce: ${t.nonce} | Class: ${t.classification}`);
    console.log(`    Deployed ${t.contractCount} contracts | Total contract ETH: ${t.totalContractEth.toFixed(6)}`);
    for (const fc of t.fundedContracts) {
      console.log(`      -> ${fc.address}: ${fc.eth.toFixed(6)} ETH`);
    }
  }

  console.log(`\n=== TOP SERIAL DEPLOYERS ===`);
  for (const d of stats.topDeployersByCount.slice(0, 10)) {
    console.log(`  ${d.address}: ${d.count} contracts | ${d.balanceEth.toFixed(6)} ETH | nonce ${d.nonce}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
