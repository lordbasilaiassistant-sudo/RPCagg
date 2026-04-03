/**
 * TokenDiscovery — Find ALL ERC-20 tokens held by a contract.
 *
 * Instead of checking a hardcoded list of 5 tokens, this module:
 * 1. Queries Transfer event logs where the contract is the recipient
 * 2. Extracts unique token contract addresses from those logs
 * 3. Batch-checks balanceOf for every discovered token
 * 4. Returns non-zero balances with token metadata (symbol, decimals)
 *
 * Uses Multicall3 for batching reads (per CLAUDE.md instructions).
 */

const { makeLogger } = require('../logger');
const log = makeLogger('token-discovery');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// ERC-20 Transfer(address,address,uint256) topic
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Function selectors
const BALANCE_OF_SEL = '70a08231';
const SYMBOL_SEL = '95d89b41';
const DECIMALS_SEL = '313ce567';
const NAME_SEL = '06fdde03';

// Well-known tokens to always check (fast path)
const KNOWN_TOKENS = [
  { symbol: 'WETH',  addr: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDbC', addr: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6d', decimals: 6 },
  { symbol: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'DAI',   addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  { symbol: 'cbETH', addr: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'DEGEN', addr: '0x4ed4E862860BeD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
  { symbol: 'AERO',  addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  { symbol: 'BRETT', addr: '0x532f27101965dd16442E59d40670FaF5eBB142E4', decimals: 18 },
  { symbol: 'TOSHI', addr: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18 },
  { symbol: 'rETH',  addr: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', decimals: 18 },
];

class TokenDiscovery {
  constructor(rpcClient) {
    this.rpc = rpcClient;
    this._tokenMetaCache = new Map();
    // Pre-fill cache with known tokens
    for (const t of KNOWN_TOKENS) {
      this._tokenMetaCache.set(t.addr.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    }
  }

  /**
   * Discover all tokens held by a contract address.
   * @param {string} contractAddr - The contract to check
   * @param {Object} opts
   * @param {number} opts.fromBlock - Start block for log search (hex string or number)
   * @param {number} opts.toBlock - End block ('latest' or hex)
   * @param {boolean} opts.includeKnownOnly - Skip log search, only check known tokens
   * @returns {Object} Map of { tokenAddr: { symbol, decimals, balance, balanceFormatted } }
   */
  async discover(contractAddr, opts = {}) {
    const addr = contractAddr.toLowerCase();
    const tokenAddresses = new Set(KNOWN_TOKENS.map(t => t.addr.toLowerCase()));

    // Step 1: Find tokens via Transfer logs (unless skipped)
    if (!opts.includeKnownOnly) {
      try {
        const discovered = await this._findTokensFromLogs(addr, opts.fromBlock, opts.toBlock);
        for (const t of discovered) {
          tokenAddresses.add(t.toLowerCase());
        }
        if (discovered.length > 0) {
          log.debug(`${addr}: discovered ${discovered.length} additional tokens from Transfer logs`);
        }
      } catch (err) {
        log.debug(`${addr}: log search failed (${err.message}), falling back to known tokens`);
      }
    }

    // Step 2: Batch check balanceOf for all discovered tokens via Multicall3
    const tokens = [...tokenAddresses];
    const balances = await this._batchBalanceOf(tokens, addr);

    // Step 3: Filter non-zero and get metadata
    const result = {};
    for (let i = 0; i < tokens.length; i++) {
      if (balances[i] > 0n) {
        const meta = await this._getTokenMeta(tokens[i]);
        const formatted = this._formatBalance(balances[i], meta.decimals);
        result[tokens[i]] = {
          symbol: meta.symbol,
          decimals: meta.decimals,
          balance: balances[i].toString(),
          balanceFormatted: formatted,
        };
      }
    }

    return result;
  }

  /**
   * Batch discover tokens for multiple contracts at once.
   * More efficient than calling discover() in a loop.
   */
  async discoverBatch(contractAddrs, opts = {}) {
    const results = {};
    // Batch in groups of 10 contracts to avoid overwhelming RPC
    const BATCH = 10;
    for (let i = 0; i < contractAddrs.length; i += BATCH) {
      const chunk = contractAddrs.slice(i, i + BATCH);
      const promises = chunk.map(addr => this.discover(addr, opts).then(r => ({ addr, tokens: r })));
      const chunkResults = await Promise.all(promises);
      for (const { addr, tokens } of chunkResults) {
        if (Object.keys(tokens).length > 0) {
          results[addr] = tokens;
        }
      }
    }
    return results;
  }

  /**
   * Find token addresses that sent Transfer events to contractAddr.
   * Uses eth_getLogs with Transfer topic, filtered by recipient (topic2).
   */
  async _findTokensFromLogs(contractAddr, fromBlock, toBlock) {
    const paddedAddr = '0x' + contractAddr.replace('0x', '').padStart(64, '0');
    const from = fromBlock ? ('0x' + (typeof fromBlock === 'number' ? fromBlock.toString(16) : fromBlock.replace('0x', ''))) : '0x0';
    const to = toBlock || 'latest';

    // Transfer(address indexed from, address indexed to, uint256 value)
    // topic[0] = Transfer signature, topic[2] = recipient
    const result = await this.rpc.call('eth_getLogs', [{
      fromBlock: from,
      toBlock: to,
      topics: [TRANSFER_TOPIC, null, paddedAddr],
    }]);

    if (!result || !Array.isArray(result)) return [];

    // Extract unique token addresses (the contract that emitted the log)
    const tokens = new Set();
    for (const entry of result) {
      if (entry.address) {
        tokens.add(entry.address.toLowerCase());
      }
    }

    return [...tokens];
  }

  /**
   * Batch balanceOf calls via Multicall3.
   * @param {string[]} tokenAddrs - Token contract addresses
   * @param {string} holder - Address to check balance for
   * @returns {BigInt[]} Array of balances
   */
  async _batchBalanceOf(tokenAddrs, holder) {
    if (tokenAddrs.length === 0) return [];

    const paddedHolder = holder.replace('0x', '').padStart(64, '0');
    const callData = '0x' + BALANCE_OF_SEL + paddedHolder;

    // Build Multicall3 aggregate3 calls
    const mc3Calls = tokenAddrs.map(addr => ({
      target: addr,
      allowFailure: true,
      callData,
    }));

    const results = [];

    // Process in chunks of 100 (per CLAUDE.md: 100 calls per aggregate3 on free RPCs)
    for (let i = 0; i < mc3Calls.length; i += 100) {
      const chunk = mc3Calls.slice(i, i + 100);
      try {
        const encoded = encodeMulticall3(chunk);
        const raw = await this.rpc.call('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest']);
        const decoded = decodeMulticall3Result(raw, chunk.length);

        for (const d of decoded) {
          if (d.success && d.data && d.data !== '0x' && d.data.length >= 66) {
            results.push(BigInt(d.data));
          } else {
            results.push(0n);
          }
        }
      } catch (err) {
        log.debug(`multicall balanceOf failed: ${err.message}`);
        // Fill with zeros for this chunk
        for (let j = 0; j < chunk.length; j++) results.push(0n);
      }
    }

    return results;
  }

  /**
   * Get token metadata (symbol, decimals). Uses cache.
   */
  async _getTokenMeta(tokenAddr) {
    const addr = tokenAddr.toLowerCase();
    if (this._tokenMetaCache.has(addr)) {
      return this._tokenMetaCache.get(addr);
    }

    let symbol = 'UNKNOWN';
    let decimals = 18;

    try {
      // Batch symbol() and decimals() via Multicall3
      const mc3Calls = [
        { target: addr, allowFailure: true, callData: '0x' + SYMBOL_SEL },
        { target: addr, allowFailure: true, callData: '0x' + DECIMALS_SEL },
      ];
      const encoded = encodeMulticall3(mc3Calls);
      const raw = await this.rpc.call('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest']);
      const decoded = decodeMulticall3Result(raw, 2);

      if (decoded[0].success && decoded[0].data.length > 2) {
        symbol = decodeString(decoded[0].data) || addr.slice(0, 10);
      }
      if (decoded[1].success && decoded[1].data.length > 2) {
        decimals = Number(BigInt(decoded[1].data));
        if (decimals > 77) decimals = 18; // sanity check
      }
    } catch (err) {
      log.debug(`metadata fetch failed for ${addr}: ${err.message}`);
    }

    const meta = { symbol, decimals };
    this._tokenMetaCache.set(addr, meta);
    return meta;
  }

  _formatBalance(balance, decimals) {
    if (balance === 0n) return '0';
    const divisor = 10n ** BigInt(decimals);
    const whole = balance / divisor;
    const frac = balance % divisor;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6);
    return `${whole}.${fracStr}`;
  }
}

// --- Multicall3 encoding/decoding (reused from treasure-hunt.js) ---

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

function decodeString(hexData) {
  try {
    const hex = hexData.replace('0x', '');
    if (hex.length < 128) {
      // Might be bytes32-encoded string (no offset/length, raw data)
      const bytes = Buffer.from(hex, 'hex');
      const end = bytes.indexOf(0);
      return bytes.slice(0, end > 0 ? end : bytes.length).toString('utf8').replace(/[^\x20-\x7E]/g, '');
    }
    // ABI-encoded string: offset (32) + length (32) + data
    const offset = parseInt(hex.substring(0, 64), 16) * 2;
    const len = parseInt(hex.substring(offset, offset + 64), 16);
    const strHex = hex.substring(offset + 64, offset + 64 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { TokenDiscovery, KNOWN_TOKENS };
