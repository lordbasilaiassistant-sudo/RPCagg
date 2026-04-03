/**
 * Deep storage slot analysis on funded contracts.
 * Reads EIP-1967, EIP-1822, EIP-2535, and generic slots 0-9
 * to identify proxy patterns, ownership, and upgrade vulnerabilities.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// EIP-1967 well-known storage slots
const SLOTS = {
  IMPL:    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  ADMIN:   '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  BEACON:  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  UUPS:    '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
  DIAMOND: '0xc8fcad8db84d3cc18b4c41d551ea0ee66dd599cde068d998e57d5e09332c131c',
};

// All funded contract addresses from scan
const FUNDED = [
  '0xc5d62829dcdb037a04bef46b3a92b32262cf6209',
  '0x843fbd3c06ee306ae6193ef02c67e54e528149a8',
  '0x923815bbb945e96e5bf9240f612b41c3708529fd',
  '0xfdcbc91c6bbbf7b8a2eaa6d2228fdf4a78ebb83b',
  '0xc94329d6498dc7840e4f7f33977c2d9212bbc77f',
  '0xec469d637e51ac2bd9258a6678a542a816f24721',
  '0x41af0e6688d661ff3110397053a08e04f8e0e88a',
  '0x23afb833dee26054c34410b6ce94aa35875b67c0',
  '0x10abdfcbf46e6ce2684a4abebf44dd548df32ab3',
  '0x7d7248499219045dfb9ca9bda11975c255e10e7e',
  '0x85a21be291145362e5b478e7b3732e530905fdbd',
  '0x4f80bde0cd1f6aef6833db46d227bdab9e0140f2',
  '0x881db58ef3f5c8e5aad4ff8087029e476825a4fa',
  '0x310f95f3df28db0fad625f604c2456e102e2010b',
];

const ZERO_SLOT = '0x' + '0'.repeat(64);

function batchRpc(calls) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(calls.map((c, i) => ({
      jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params
    })));
    const req = http.request({
      hostname: '127.0.0.1', port: 8545, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const sorted = Array.isArray(parsed) ? parsed.sort((a, b) => a.id - b.id) : [parsed];
          resolve(sorted.map(r => r.result || null));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function slotToAddress(val) {
  if (!val || val === ZERO_SLOT) return null;
  return '0x' + val.slice(-40);
}

function isNonZero(val) {
  return val && val !== ZERO_SLOT;
}

async function analyzeContract(address) {
  const calls = [];

  // EIP-1967 slots (indices 0-4)
  calls.push({ method: 'eth_getStorageAt', params: [address, SLOTS.IMPL, 'latest'] });
  calls.push({ method: 'eth_getStorageAt', params: [address, SLOTS.ADMIN, 'latest'] });
  calls.push({ method: 'eth_getStorageAt', params: [address, SLOTS.BEACON, 'latest'] });
  calls.push({ method: 'eth_getStorageAt', params: [address, SLOTS.UUPS, 'latest'] });
  calls.push({ method: 'eth_getStorageAt', params: [address, SLOTS.DIAMOND, 'latest'] });

  // Generic storage slots 0-9 (indices 5-14)
  for (let i = 0; i <= 9; i++) {
    calls.push({ method: 'eth_getStorageAt', params: [address, '0x' + i.toString(16).padStart(64, '0'), 'latest'] });
  }

  // Get balance (15) and code (16)
  calls.push({ method: 'eth_getBalance', params: [address, 'latest'] });
  calls.push({ method: 'eth_getCode', params: [address, 'latest'] });

  const results = await batchRpc(calls);

  const impl = slotToAddress(results[0]);
  const admin = slotToAddress(results[1]);
  const beacon = slotToAddress(results[2]);
  const uups = results[3];
  const diamond = results[4];

  const genericSlots = [];
  for (let i = 0; i <= 9; i++) {
    const val = results[5 + i];
    if (isNonZero(val)) {
      genericSlots.push({
        slot: i,
        rawValue: val,
        asAddress: slotToAddress(val),
        asUint256: BigInt(val).toString(),
      });
    }
  }

  const balance = results[15] ? BigInt(results[15]) : 0n;
  const code = results[16];
  const codeSize = code ? (code.length - 2) / 2 : 0;

  // Detect proxy type from storage
  let proxyType = 'none';
  let implementation = null;

  if (impl) {
    proxyType = 'eip1967';
    implementation = impl;
  }
  if (beacon) {
    proxyType = 'beacon';
  }
  if (uups && isNonZero(uups)) {
    proxyType = 'uups';
  }
  if (diamond && isNonZero(diamond)) {
    proxyType = 'diamond';
  }

  // Check for EIP-1167 minimal proxy in bytecode
  if (code) {
    const hex = code.toLowerCase().replace('0x', '');
    if (hex.startsWith('363d3d373d3d3d363d73') && hex.endsWith('5af43d82803e903d91602b57fd5bf3')) {
      proxyType = 'eip1167-minimal';
      implementation = '0x' + hex.substring(20, 60);
    }
  }

  // Identify ownership from generic slots
  let likelyOwner = null;
  let ownerSlot = null;
  for (const gs of genericSlots) {
    if (gs.rawValue && gs.rawValue.substring(0, 26) === '0x000000000000000000000000' && gs.rawValue.substring(26) !== '0'.repeat(40)) {
      if (likelyOwner === null) {
        likelyOwner = gs.asAddress;
        ownerSlot = gs.slot;
      }
    }
  }

  // Vulnerability assessment
  const vulns = [];

  if (proxyType === 'eip1967' && !admin) {
    vulns.push('EIP-1967 proxy with no admin slot set - may have unprotected upgrade function');
  }
  if (proxyType === 'eip1967' && admin) {
    vulns.push('EIP-1967 proxy with admin: ' + admin + ' - admin can upgrade implementation');
  }
  if (implementation) {
    vulns.push('Proxy delegates to implementation: ' + implementation + ' - need to check implementation code');
  }
  if (likelyOwner && likelyOwner !== '0x' + '0'.repeat(40) && !likelyOwner.endsWith('dead')) {
    vulns.push('Has active owner (' + likelyOwner + ') in slot ' + ownerSlot + ' - owner-gated functions callable by this EOA only');
  }
  if (likelyOwner === '0x' + '0'.repeat(40) || (likelyOwner && likelyOwner.endsWith('dead'))) {
    vulns.push('Ownership renounced - no owner-gated extraction possible');
  }

  return {
    address,
    ethBalance: (Number(balance) / 1e18).toFixed(6),
    codeSize,
    proxyType,
    implementation,
    admin,
    beacon: beacon || null,
    uupsSlotValue: isNonZero(uups) ? uups : null,
    diamondSlotValue: isNonZero(diamond) ? diamond : null,
    likelyOwner,
    ownerSlot,
    genericSlots,
    vulnerabilities: vulns,
  };
}

async function main() {
  console.log('Deep storage slot analysis on ' + FUNDED.length + ' funded contracts...\n');

  const results = [];
  for (const addr of FUNDED) {
    try {
      const r = await analyzeContract(addr);
      results.push(r);
      console.log(r.address + ' | ' + r.ethBalance + ' ETH | proxy: ' + r.proxyType + ' | owner: ' + (r.likelyOwner || 'unknown') + ' | slots: ' + r.genericSlots.length);
      if (r.implementation) console.log('  -> impl: ' + r.implementation);
      if (r.admin) console.log('  -> admin: ' + r.admin);
      for (const v of r.vulnerabilities) console.log('  [!] ' + v);
    } catch (e) {
      console.error('Error on ' + addr + ': ' + e.message);
    }
  }

  // Summary
  const withImpl = results.filter(r => r.implementation);
  const withAdmin = results.filter(r => r.admin);
  const withOwner = results.filter(r => r.likelyOwner);
  const realProxies = results.filter(r => r.proxyType !== 'none');

  console.log('\n=== SUMMARY ===');
  console.log('Total analyzed: ' + results.length);
  console.log('Real proxies (from storage): ' + realProxies.length);
  console.log('With implementation address: ' + withImpl.length);
  console.log('With admin address: ' + withAdmin.length);
  console.log('With identifiable owner: ' + withOwner.length);

  // Write results
  const outPath = path.join(__dirname, 'data', 'storage-slot-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify({
    analysis: 'Deep Storage Slot Analysis',
    scanDate: new Date().toISOString(),
    contractCount: results.length,
    summary: {
      realProxies: realProxies.length,
      withImplementation: withImpl.length,
      withAdmin: withAdmin.length,
      withOwner: withOwner.length,
    },
    contracts: results,
  }, null, 2));
  console.log('\nResults written to ' + outPath);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
