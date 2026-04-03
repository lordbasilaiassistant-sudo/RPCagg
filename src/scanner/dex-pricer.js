/**
 * DexPricer — Dynamic token pricing via DEX pair reserves.
 *
 * Instead of enumerating millions of pairs, does reverse lookups:
 * For each token, queries factory.getPair(token, WETH) to find a WETH pair.
 * If found, reads reserves and computes price in ETH.
 * Falls back to intermediate routing (token -> USDC -> ETH) if no direct WETH pair.
 *
 * Supports multiple DEX factories (Uniswap V2, BaseSwap, SushiSwap).
 * Uses Multicall3 for batching all reads.
 */

const { makeLogger } = require('../logger');
const log = makeLogger('dex-pricer');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = '0x4200000000000000000000000000000000000006';

// Stablecoins for intermediate routing (token -> stable -> ETH)
const STABLES = [
  { addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  { addr: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6d', symbol: 'USDbC', decimals: 6 },
  { addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 },
];

// V2-style factories on Base (all use getPair(tokenA, tokenB) and standard pair interface)
const FACTORIES = [
  { name: 'UniswapV2', addr: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' },
  { name: 'BaseSwap',  addr: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB' },
  { name: 'SushiSwap', addr: '0x71524B4f93c58fcbF659783284E38825f0622859' },
];

// Function selectors
const GET_PAIR_SEL = 'e6a43905';       // getPair(address,address)
const GET_RESERVES_SEL = '0902f1ac';   // getReserves()
const TOKEN0_SEL = '0dfe1681';         // token0()
const TOKEN1_SEL = 'd21220a7';         // token1()

// Tokens that ARE ETH-equivalent (no need to price)
const ETH_EQUIVALENTS = new Set([
  WETH.toLowerCase(),
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
  '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c', // rETH
]);

class DexPricer {
  constructor(rpcClient) {
    this.rpc = rpcClient;
    this._priceCache = new Map();   // tokenAddr -> { ethPrice, timestamp }
    this._pairCache = new Map();    // `${factory}:${tokenA}:${tokenB}` -> pairAddr
    this._cacheTtl = 60_000;        // 60s cache TTL
    this._ethUsdPrice = null;       // cached ETH/USD from USDC pair
    this._ethUsdTimestamp = 0;
  }

  /**
   * Price a single token in ETH.
   * @param {string} tokenAddr
   * @param {number} decimals - Token decimals (default 18)
   * @returns {{ ethPrice: number, source: string } | null}
   */
  async priceInEth(tokenAddr, decimals = 18) {
    const addr = tokenAddr.toLowerCase();

    // ETH-equivalents are ~1 ETH
    if (ETH_EQUIVALENTS.has(addr)) {
      return { ethPrice: 1.0, source: 'eth-equivalent' };
    }

    // Check cache
    const cached = this._priceCache.get(addr);
    if (cached && Date.now() - cached.timestamp < this._cacheTtl) {
      return { ethPrice: cached.ethPrice, source: cached.source + ' (cached)' };
    }

    // Strategy 1: Direct WETH pair
    const directPrice = await this._priceViaWethPair(addr, decimals);
    if (directPrice) {
      this._priceCache.set(addr, { ...directPrice, timestamp: Date.now() });
      return directPrice;
    }

    // Strategy 2: Route through stablecoin (token -> USDC -> ETH)
    const routedPrice = await this._priceViaStableRoute(addr, decimals);
    if (routedPrice) {
      this._priceCache.set(addr, { ...routedPrice, timestamp: Date.now() });
      return routedPrice;
    }

    return null;
  }

  /**
   * Batch price multiple tokens at once. Returns map of addr -> { ethPrice, source }.
   * @param {Array<{addr: string, decimals: number}>} tokens
   */
  async priceBatch(tokens) {
    const results = {};

    // Split into cached vs uncached
    const toQuery = [];
    for (const t of tokens) {
      const addr = t.addr.toLowerCase();
      if (ETH_EQUIVALENTS.has(addr)) {
        results[addr] = { ethPrice: 1.0, source: 'eth-equivalent' };
        continue;
      }
      const cached = this._priceCache.get(addr);
      if (cached && Date.now() - cached.timestamp < this._cacheTtl) {
        results[addr] = { ethPrice: cached.ethPrice, source: cached.source + ' (cached)' };
        continue;
      }
      toQuery.push(t);
    }

    if (toQuery.length === 0) return results;

    // Batch find WETH pairs across all factories via Multicall3
    const pairResults = await this._batchFindWethPairs(toQuery.map(t => t.addr));

    // For pairs found, batch read reserves
    const pairsToRead = [];
    const pairTokenMap = {};
    for (let i = 0; i < toQuery.length; i++) {
      const addr = toQuery[i].addr.toLowerCase();
      const pairAddr = pairResults[i];
      if (pairAddr && pairAddr !== '0x0000000000000000000000000000000000000000') {
        pairsToRead.push(pairAddr);
        pairTokenMap[pairAddr] = { addr, decimals: toQuery[i].decimals };
      }
    }

    if (pairsToRead.length > 0) {
      const reserveData = await this._batchReadReserves(pairsToRead);

      for (let i = 0; i < pairsToRead.length; i++) {
        const pair = pairsToRead[i];
        const { addr, decimals } = pairTokenMap[pair];
        const data = reserveData[i];

        if (data && data.reserve0 > 0n && data.reserve1 > 0n) {
          const ethPrice = this._computePrice(
            data.token0, data.reserve0, data.reserve1,
            addr, decimals
          );
          if (ethPrice > 0) {
            const source = `direct-weth:${data.factory || 'unknown'}`;
            results[addr] = { ethPrice, source };
            this._priceCache.set(addr, { ethPrice, source, timestamp: Date.now() });
          }
        }
      }
    }

    // For tokens still not priced, try stable route (sequentially, less common)
    for (const t of toQuery) {
      const addr = t.addr.toLowerCase();
      if (!results[addr]) {
        const routed = await this._priceViaStableRoute(addr, t.decimals);
        if (routed) {
          results[addr] = routed;
          this._priceCache.set(addr, { ...routed, timestamp: Date.now() });
        }
      }
    }

    return results;
  }

  /**
   * Get ETH price in USD (from WETH/USDC pair).
   */
  async getEthUsdPrice() {
    if (this._ethUsdPrice && Date.now() - this._ethUsdTimestamp < this._cacheTtl) {
      return this._ethUsdPrice;
    }

    const usdcAddr = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    for (const factory of FACTORIES) {
      const pairAddr = await this._getPair(factory.addr, WETH, usdcAddr);
      if (!pairAddr) continue;

      const data = await this._readPairData(pairAddr);
      if (!data || data.reserve0 === 0n || data.reserve1 === 0n) continue;

      let ethReserve, usdcReserve;
      if (data.token0.toLowerCase() === WETH.toLowerCase()) {
        ethReserve = data.reserve0;
        usdcReserve = data.reserve1;
      } else {
        ethReserve = data.reserve1;
        usdcReserve = data.reserve0;
      }

      // USDC has 6 decimals, ETH has 18
      const price = (Number(usdcReserve) / 1e6) / (Number(ethReserve) / 1e18);
      if (price > 0 && price < 1_000_000) {
        this._ethUsdPrice = price;
        this._ethUsdTimestamp = Date.now();
        return price;
      }
    }

    return null;
  }

  /**
   * Compute the ETH value of a token balance.
   * @param {string} tokenAddr
   * @param {bigint|string} balance - Raw token balance
   * @param {number} decimals
   * @returns {{ ethValue: number, usdValue: number|null } | null}
   */
  async valueInEth(tokenAddr, balance, decimals = 18) {
    const price = await this.priceInEth(tokenAddr, decimals);
    if (!price) return null;

    const bal = typeof balance === 'bigint' ? balance : BigInt(balance);
    const formatted = Number(bal) / (10 ** decimals);
    const ethValue = formatted * price.ethPrice;

    let usdValue = null;
    const ethUsd = await this.getEthUsdPrice();
    if (ethUsd) usdValue = ethValue * ethUsd;

    return { ethValue, usdValue, source: price.source };
  }

  // --- Internal methods ---

  async _priceViaWethPair(tokenAddr, decimals) {
    for (const factory of FACTORIES) {
      const pairAddr = await this._getPair(factory.addr, tokenAddr, WETH);
      if (!pairAddr) continue;

      const data = await this._readPairData(pairAddr);
      if (!data || data.reserve0 === 0n || data.reserve1 === 0n) continue;

      const ethPrice = this._computePrice(data.token0, data.reserve0, data.reserve1, tokenAddr, decimals);
      if (ethPrice > 0) {
        return { ethPrice, source: `direct-weth:${factory.name}` };
      }
    }
    return null;
  }

  async _priceViaStableRoute(tokenAddr, decimals) {
    for (const stable of STABLES) {
      for (const factory of FACTORIES) {
        // Step 1: token -> stable pair
        const tokenStablePair = await this._getPair(factory.addr, tokenAddr, stable.addr);
        if (!tokenStablePair) continue;

        const data1 = await this._readPairData(tokenStablePair);
        if (!data1 || data1.reserve0 === 0n || data1.reserve1 === 0n) continue;

        // Price token in stable
        const stablePrice = this._computePriceInQuote(
          data1.token0, data1.reserve0, data1.reserve1,
          tokenAddr, decimals, stable.addr, stable.decimals
        );
        if (!stablePrice || stablePrice <= 0) continue;

        // Step 2: stable -> WETH pair
        const stableEthPair = await this._getPair(factory.addr, stable.addr, WETH);
        if (!stableEthPair) continue;

        const data2 = await this._readPairData(stableEthPair);
        if (!data2 || data2.reserve0 === 0n || data2.reserve1 === 0n) continue;

        // Price stable in ETH
        const stableEthPrice = this._computePrice(
          data2.token0, data2.reserve0, data2.reserve1,
          stable.addr, stable.decimals
        );
        if (!stableEthPrice || stableEthPrice <= 0) continue;

        const ethPrice = stablePrice * stableEthPrice;
        if (ethPrice > 0 && isFinite(ethPrice)) {
          return { ethPrice, source: `routed:${stable.symbol}:${factory.name}` };
        }
      }
    }
    return null;
  }

  _computePrice(token0, reserve0, reserve1, targetToken, targetDecimals) {
    const isToken0 = token0.toLowerCase() === targetToken.toLowerCase();

    let tokenReserve, wethReserve;
    if (isToken0) {
      tokenReserve = reserve0;
      wethReserve = reserve1;
    } else {
      tokenReserve = reserve1;
      wethReserve = reserve0;
    }

    if (tokenReserve === 0n) return 0;

    // Price = (wethReserve / 10^18) / (tokenReserve / 10^targetDecimals)
    const ethVal = Number(wethReserve) / 1e18;
    const tokenVal = Number(tokenReserve) / (10 ** targetDecimals);

    if (tokenVal === 0) return 0;
    return ethVal / tokenVal;
  }

  _computePriceInQuote(token0, reserve0, reserve1, baseToken, baseDecimals, quoteToken, quoteDecimals) {
    const isBase0 = token0.toLowerCase() === baseToken.toLowerCase();

    let baseReserve, quoteReserve;
    if (isBase0) {
      baseReserve = reserve0;
      quoteReserve = reserve1;
    } else {
      baseReserve = reserve1;
      quoteReserve = reserve0;
    }

    if (baseReserve === 0n) return 0;

    const quoteVal = Number(quoteReserve) / (10 ** quoteDecimals);
    const baseVal = Number(baseReserve) / (10 ** baseDecimals);

    if (baseVal === 0) return 0;
    return quoteVal / baseVal;
  }

  async _getPair(factoryAddr, tokenA, tokenB) {
    const key = `${factoryAddr}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`;
    const keyRev = `${factoryAddr}:${tokenB.toLowerCase()}:${tokenA.toLowerCase()}`;

    if (this._pairCache.has(key)) return this._pairCache.get(key);
    if (this._pairCache.has(keyRev)) return this._pairCache.get(keyRev);

    const padA = tokenA.replace('0x', '').toLowerCase().padStart(64, '0');
    const padB = tokenB.replace('0x', '').toLowerCase().padStart(64, '0');
    const callData = '0x' + GET_PAIR_SEL + padA + padB;

    try {
      const result = await this.rpc.call('eth_call', [{ to: factoryAddr, data: callData }, 'latest']);
      const pairAddr = '0x' + result.slice(26);
      const isZero = pairAddr === '0x0000000000000000000000000000000000000000';

      this._pairCache.set(key, isZero ? null : pairAddr);
      return isZero ? null : pairAddr;
    } catch {
      this._pairCache.set(key, null);
      return null;
    }
  }

  async _readPairData(pairAddr) {
    try {
      // Batch: getReserves + token0 + token1
      const results = await this.rpc.batch([
        { method: 'eth_call', params: [{ to: pairAddr, data: '0x' + GET_RESERVES_SEL }, 'latest'] },
        { method: 'eth_call', params: [{ to: pairAddr, data: '0x' + TOKEN0_SEL }, 'latest'] },
        { method: 'eth_call', params: [{ to: pairAddr, data: '0x' + TOKEN1_SEL }, 'latest'] },
      ]);

      const reservesHex = typeof results[0] === 'string' ? results[0] : results[0]?.result || '0x';
      const token0Hex = typeof results[1] === 'string' ? results[1] : results[1]?.result || '0x';
      const token1Hex = typeof results[2] === 'string' ? results[2] : results[2]?.result || '0x';

      if (reservesHex.length < 130) return null;

      const reserve0 = BigInt('0x' + reservesHex.slice(2, 66));
      const reserve1 = BigInt('0x' + reservesHex.slice(66, 130));
      const token0 = '0x' + token0Hex.slice(26);
      const token1 = '0x' + token1Hex.slice(26);

      return { reserve0, reserve1, token0, token1 };
    } catch (err) {
      log.debug(`readPairData failed for ${pairAddr}: ${err.message}`);
      return null;
    }
  }

  /**
   * Batch find WETH pairs for multiple tokens across all factories.
   * Returns best pair address for each token (first factory that has one).
   */
  async _batchFindWethPairs(tokenAddrs) {
    const results = new Array(tokenAddrs.length).fill(null);

    for (const factory of FACTORIES) {
      // Build Multicall3 calls for getPair(token, WETH) for all unsolved tokens
      const mc3Calls = [];
      const indices = [];

      for (let i = 0; i < tokenAddrs.length; i++) {
        if (results[i]) continue; // already found

        const addr = tokenAddrs[i].toLowerCase();
        const padToken = addr.replace('0x', '').padStart(64, '0');
        const padWeth = WETH.replace('0x', '').toLowerCase().padStart(64, '0');
        const callData = '0x' + GET_PAIR_SEL + padToken + padWeth;

        mc3Calls.push({
          target: factory.addr,
          allowFailure: true,
          callData,
        });
        indices.push(i);
      }

      if (mc3Calls.length === 0) break;

      // Execute via Multicall3 in chunks of 100
      try {
        const encoded = encodeMulticall3(mc3Calls);
        const raw = await this.rpc.call('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest']);
        const decoded = decodeMulticall3Result(raw, mc3Calls.length);

        for (let j = 0; j < decoded.length; j++) {
          if (decoded[j].success && decoded[j].data && decoded[j].data.length >= 42) {
            const pairAddr = '0x' + decoded[j].data.slice(26);
            if (pairAddr !== '0x0000000000000000000000000000000000000000') {
              results[indices[j]] = pairAddr;
            }
          }
        }
      } catch (err) {
        log.debug(`batch getPair failed for ${factory.name}: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Batch read reserves + token0/token1 for multiple pairs.
   */
  async _batchReadReserves(pairAddrs) {
    const results = new Array(pairAddrs.length).fill(null);

    // 3 calls per pair (reserves, token0, token1). Batch 30 pairs = 90 calls per Multicall3.
    const PAIRS_PER_BATCH = 30;

    for (let i = 0; i < pairAddrs.length; i += PAIRS_PER_BATCH) {
      const chunk = pairAddrs.slice(i, i + PAIRS_PER_BATCH);
      const mc3Calls = [];

      for (const pair of chunk) {
        mc3Calls.push({ target: pair, allowFailure: true, callData: '0x' + GET_RESERVES_SEL });
        mc3Calls.push({ target: pair, allowFailure: true, callData: '0x' + TOKEN0_SEL });
        mc3Calls.push({ target: pair, allowFailure: true, callData: '0x' + TOKEN1_SEL });
      }

      try {
        const encoded = encodeMulticall3(mc3Calls);
        const raw = await this.rpc.call('eth_call', [{ to: MULTICALL3, data: encoded }, 'latest']);
        const decoded = decodeMulticall3Result(raw, mc3Calls.length);

        for (let j = 0; j < chunk.length; j++) {
          const resIdx = j * 3;
          const reserveRes = decoded[resIdx];
          const token0Res = decoded[resIdx + 1];
          const token1Res = decoded[resIdx + 2];

          if (reserveRes.success && reserveRes.data.length >= 130 &&
              token0Res.success && token1Res.success) {
            const rHex = reserveRes.data.replace('0x', '');
            results[i + j] = {
              reserve0: BigInt('0x' + rHex.slice(0, 64)),
              reserve1: BigInt('0x' + rHex.slice(64, 128)),
              token0: '0x' + token0Res.data.slice(26),
              token1: '0x' + token1Res.data.slice(26),
            };
          }
        }
      } catch (err) {
        log.debug(`batch reserves failed: ${err.message}`);
      }
    }

    return results;
  }

  /** Get pricing stats */
  getStats() {
    return {
      cachedPrices: this._priceCache.size,
      cachedPairs: this._pairCache.size,
      ethUsd: this._ethUsdPrice,
    };
  }
}


// --- Multicall3 encoding/decoding (matches token-discovery.js implementation) ---

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


module.exports = { DexPricer, FACTORIES, WETH, STABLES };
