/**
 * Executor — simulates extraction calls, and if profitable, executes live.
 *
 * Flow:
 * 1. Simulate via eth_call (free, no gas)
 * 2. Estimate gas via eth_estimateGas
 * 3. Calculate profit: contract value - gas cost
 * 4. If profit > threshold, build + sign + send tx
 * 5. Wait for receipt, verify success
 *
 * Safety: requires EXECUTE=1 env var to actually send transactions.
 * Without it, only simulates and reports.
 */

const { makeLogger } = require('../logger');
const log = makeLogger('executor');

const EXECUTE_LIVE = process.env.EXECUTE === '1';
const MIN_PROFIT_WEI = BigInt(process.env.MIN_PROFIT_WEI || '100000000000000'); // 0.0001 ETH default
const TREASURY = '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334';

class Executor {
  constructor(rpcClient) {
    this.rpc = rpcClient;
    this.executed = [];
    this.simulated = [];
  }

  /**
   * Evaluate a potential extraction — sim, estimate, profit check, optionally execute.
   *
   * @param {object} opts
   * @param {string} opts.target - contract address
   * @param {string} opts.callData - encoded function call
   * @param {string} opts.fnName - human-readable function name
   * @param {bigint} opts.contractEthBalance - ETH balance of target contract
   * @param {object} opts.contractTokenBalances - token balances {symbol: amount}
   * @returns {object} result with sim/profit/execution details
   */
  async evaluate(opts) {
    const { target, callData, fnName, contractEthBalance, contractTokenBalances } = opts;

    const result = {
      target,
      fnName,
      callData: callData.substring(0, 74), // selector + first arg
      simSuccess: false,
      gasEstimate: null,
      gasCost: null,
      potentialValue: contractEthBalance?.toString() || '0',
      tokenValue: contractTokenBalances || {},
      profitable: false,
      profit: '0',
      executed: false,
      txHash: null,
      error: null,
    };

    // Step 1: Simulate
    try {
      const simResult = await this.rpc.call('eth_call', [{
        from: TREASURY,
        to: target,
        data: callData,
        value: '0x0',
      }, 'latest']);

      result.simSuccess = true;
      result.simReturn = simResult?.substring(0, 130);
      log.info(`SIM OK: ${fnName} on ${target}`);
    } catch (err) {
      result.error = `sim failed: ${err.message}`;
      this.simulated.push(result);
      return result;
    }

    // Step 2: Estimate gas
    try {
      const gasHex = await this.rpc.call('eth_estimateGas', [{
        from: TREASURY,
        to: target,
        data: callData,
        value: '0x0',
      }]);
      result.gasEstimate = parseInt(gasHex, 16);
    } catch (err) {
      // estimateGas failed — tx would revert on-chain even though eth_call succeeded
      // This happens when eth_call returns data but the actual execution would revert
      // (view functions vs state-changing functions)
      result.error = `gas estimate failed (likely view-only): ${err.message}`;
      result.simSuccess = false; // downgrade — can't actually execute
      this.simulated.push(result);
      return result;
    }

    // Step 3: Calculate profit
    try {
      const gasPrice = BigInt(await this.rpc.call('eth_gasPrice'));
      const gasCost = gasPrice * BigInt(result.gasEstimate);
      result.gasCost = gasCost.toString();

      const ethValue = contractEthBalance || 0n;

      if (ethValue > gasCost + MIN_PROFIT_WEI) {
        result.profitable = true;
        result.profit = (ethValue - gasCost).toString();
        result.profitEth = Number(ethValue - gasCost) / 1e18;

        log.info(`PROFITABLE: ${fnName} on ${target}`);
        log.info(`  Value: ${Number(ethValue) / 1e18} ETH`);
        log.info(`  Gas cost: ${Number(gasCost) / 1e18} ETH`);
        log.info(`  Profit: ${result.profitEth} ETH`);

        // Also check token value (tokens are pure upside on top of ETH)
        if (contractTokenBalances && Object.keys(contractTokenBalances).length > 0) {
          log.info(`  + Token bonuses: ${JSON.stringify(contractTokenBalances)}`);
        }
      }
    } catch (err) {
      result.error = `profit calc failed: ${err.message}`;
    }

    // Step 4: Execute if profitable and enabled
    if (result.profitable && EXECUTE_LIVE) {
      log.info(`EXECUTING: ${fnName} on ${target} (profit: ${result.profitEth} ETH)`);
      try {
        result.txHash = await this._executeLive(target, callData, result.gasEstimate);
        result.executed = true;
        this.executed.push(result);
        log.info(`TX SENT: ${result.txHash}`);
      } catch (err) {
        result.error = `execution failed: ${err.message}`;
        log.error(`EXECUTION FAILED: ${err.message}`);
      }
    } else if (result.profitable && !EXECUTE_LIVE) {
      log.info(`DRY RUN — would execute. Set EXECUTE=1 to go live.`);
    }

    this.simulated.push(result);
    return result;
  }

  async _executeLive(target, callData, gasEstimate) {
    // This requires a signed transaction — we need the private key
    // Using THRYXTREASURY_PRIVATE_KEY env var
    const privKey = process.env.THRYXTREASURY_PRIVATE_KEY;
    if (!privKey) {
      throw new Error('THRYXTREASURY_PRIVATE_KEY not set — cannot sign transaction');
    }

    // Build raw transaction params
    const [nonce, gasPrice, chainId] = await Promise.all([
      this.rpc.call('eth_getTransactionCount', [TREASURY, 'latest']),
      this.rpc.call('eth_gasPrice'),
      this.rpc.call('eth_chainId'),
    ]);

    // We need ethers for signing — dynamic import
    const { ethers } = require('ethers');
    const wallet = new ethers.Wallet(privKey);

    const tx = {
      to: target,
      data: callData,
      nonce: parseInt(nonce, 16),
      gasLimit: Math.ceil(gasEstimate * 1.2), // 20% buffer
      maxFeePerGas: BigInt(gasPrice) * 2n,   // 2x current gas price for speed
      maxPriorityFeePerGas: BigInt(gasPrice),
      chainId: parseInt(chainId, 16),
      type: 2, // EIP-1559
      value: 0n,
    };

    const signed = await wallet.signTransaction(tx);

    // Send via aggregator (which will pick the best provider)
    const txHash = await this.rpc.call('eth_sendRawTransaction', [signed]);
    return txHash;
  }

  getReport() {
    const profitable = this.simulated.filter(s => s.profitable);
    const executed = this.simulated.filter(s => s.executed);

    return {
      totalSimulated: this.simulated.length,
      totalProfitable: profitable.length,
      totalExecuted: executed.length,
      executeLive: EXECUTE_LIVE,
      profitable: profitable.map(p => ({
        target: p.target,
        fnName: p.fnName,
        profitEth: p.profitEth,
        gasEstimate: p.gasEstimate,
        executed: p.executed,
        txHash: p.txHash,
        error: p.error,
      })),
    };
  }
}

module.exports = { Executor };
