/**
 * ContractScanner — given a list of contract addresses, fetches bytecode and classifies them.
 * Detects: EOA vs contract, proxy patterns (EIP-1167, EIP-1967, UUPS, diamond), factory patterns.
 */

const { BaseScanner } = require('./base-scanner');

// EIP-1167 minimal proxy bytecode prefix (first 10 bytes)
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

// EIP-1967 storage slots
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// Common function selectors for classification
const SELECTORS = {
  'facets()': '7a0ed627',              // Diamond (EIP-2535)
  'implementation()': '5c60da1b',       // Transparent proxy
  'proxiableUUID()': '52d1902d',        // UUPS
  'upgradeTo(address)': '3659cfe6',     // UUPS upgrade
  'owner()': '8da5cb5b',
  'paused()': '5c975abb',
};

class ContractScanner extends BaseScanner {
  constructor(rpcClient, opts = {}) {
    super('contract-scanner', rpcClient);
    this.batchSize = opts.batchSize || 20;
    this.onContract = opts.onContract || null; // callback(contractInfo)
  }

  // Scan a batch of addresses
  async scanAddresses(addresses) {
    const results = [];

    for (let i = 0; i < addresses.length; i += this.batchSize) {
      if (!this.running) break;
      const chunk = addresses.slice(i, i + this.batchSize);

      // Fetch bytecode for all addresses in batch
      const codeCalls = chunk.map(addr => ({
        method: 'eth_getCode',
        params: [addr, 'latest'],
      }));

      const codes = await this.rpc.batch(codeCalls);

      for (let j = 0; j < chunk.length; j++) {
        const addr = chunk[j];
        const code = codes[j];

        if (!code || code === '0x' || code.error) {
          // EOA or error
          continue;
        }

        const info = this._classifyBytecode(addr, code);

        // Check proxy storage slots if it looks like a proxy
        if (info.isProxy) {
          await this._resolveProxyTarget(info);
        }

        results.push(info);
        this.recordProgress();

        if (this.onContract) {
          await this.onContract(info);
        }
      }
    }

    return results;
  }

  _classifyBytecode(address, bytecode) {
    const code = bytecode.toLowerCase().replace('0x', '');
    const info = {
      address,
      codeSize: code.length / 2,
      isProxy: false,
      proxyType: null,
      implementation: null,
      isFactory: false,
      hasSelfdestruct: false,
      selectors: [],
    };

    // EIP-1167 minimal proxy detection
    if (code.startsWith(EIP1167_PREFIX) && code.endsWith(EIP1167_SUFFIX)) {
      info.isProxy = true;
      info.proxyType = 'eip1167-minimal';
      // Extract implementation address (20 bytes after prefix)
      info.implementation = '0x' + code.substring(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40);
      return info;
    }

    // Check for DELEGATECALL opcode (0xf4)
    if (code.includes('f4')) {
      info.isProxy = true;
      info.proxyType = 'delegatecall'; // will be refined below
    }

    // Check for CREATE/CREATE2 opcodes (factory detection)
    if (code.includes('f0') || code.includes('f5')) {
      info.isFactory = true;
    }

    // SELFDESTRUCT detection (0xff)
    if (code.includes('ff')) {
      info.hasSelfdestruct = true;
    }

    // Extract function selectors from bytecode
    // Pattern: PUSH4 <selector> EQ (63 XX XX XX XX 14)
    const selectorRegex = /63([0-9a-f]{8})14/g;
    let match;
    while ((match = selectorRegex.exec(code)) !== null) {
      info.selectors.push(match[1]);
    }

    // Check for known proxy selectors
    if (info.selectors.includes(SELECTORS['facets()'])) {
      info.isProxy = true;
      info.proxyType = 'diamond-eip2535';
    } else if (info.selectors.includes(SELECTORS['proxiableUUID()'])) {
      info.isProxy = true;
      info.proxyType = 'uups';
    } else if (info.selectors.includes(SELECTORS['implementation()'])) {
      info.isProxy = true;
      info.proxyType = 'transparent';
    }

    return info;
  }

  async _resolveProxyTarget(info) {
    try {
      // Read EIP-1967 implementation slot
      const calls = [
        { method: 'eth_getStorageAt', params: [info.address, IMPL_SLOT, 'latest'] },
        { method: 'eth_getStorageAt', params: [info.address, ADMIN_SLOT, 'latest'] },
        { method: 'eth_getStorageAt', params: [info.address, BEACON_SLOT, 'latest'] },
      ];

      const [implRaw, adminRaw, beaconRaw] = await this.rpc.batch(calls);

      const impl = this._slotToAddress(implRaw);
      const admin = this._slotToAddress(adminRaw);
      const beacon = this._slotToAddress(beaconRaw);

      if (impl) {
        info.implementation = impl;
        if (!info.proxyType || info.proxyType === 'delegatecall') {
          info.proxyType = 'eip1967';
        }
      }
      if (admin) info.admin = admin;
      if (beacon) {
        info.beacon = beacon;
        info.proxyType = 'beacon';
      }
    } catch (err) {
      this.log.debug(`proxy resolution failed: ${info.address}`, { error: err.message });
    }
  }

  _slotToAddress(slotValue) {
    if (!slotValue || typeof slotValue !== 'string') return null;
    const hex = slotValue.replace('0x', '');
    // Address is the last 40 chars of the 32-byte slot
    const addr = '0x' + hex.slice(-40);
    // Zero address means slot is empty
    if (addr === '0x' + '0'.repeat(40)) return null;
    return addr;
  }
}

module.exports = { ContractScanner, IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT };
