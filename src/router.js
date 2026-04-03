/**
 * RPC Router
 * Takes an incoming JSON-RPC request, selects a provider via strategy,
 * forwards the request, handles retries + failover.
 */

const strategies = require('./strategies');
const { makeLogger } = require('./logger');
const log = makeLogger('router');

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;

class Router {
  constructor(healthChecker, strategyName = 'fastest') {
    this.health = healthChecker;
    this.setStrategy(strategyName);
    this.stats = { total: 0, success: 0, errors: 0, retries: 0 };
  }

  setStrategy(name) {
    const s = strategies[name];
    if (!s) throw new Error(`Unknown strategy: ${name}. Available: ${Object.keys(strategies).join(', ')}`);
    this.strategy = s;
    this.strategyName = name;
    log.info(`strategy set: ${name}`);
  }

  async forwardRequest(rpcBody) {
    this.stats.total++;

    // Race strategy: fire at multiple providers simultaneously
    if (this.strategyName === 'race') {
      return this._raceRequest(rpcBody);
    }

    // Standard: single-provider with retry
    return this._retryRequest(rpcBody, 0);
  }

  async _retryRequest(rpcBody, attempt) {
    const providers = this.health.providers;
    const provider = this.strategy.select(providers, this.health);

    if (!provider) {
      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32000, message: 'No healthy providers available' } };
    }

    try {
      const result = await this._sendToProvider(provider, rpcBody);
      this.stats.success++;
      log.debug(`routed to ${provider.name}`, { method: rpcBody.method });
      return result;
    } catch (err) {
      log.warn(`failed: ${provider.name}`, { method: rpcBody.method, error: err.message, attempt });

      // Record failure for health tracking
      const state = this.health.getState(provider.name);
      if (state) {
        state.totalRequests++;
        state.totalErrors++;
        state.failures++;
      }

      if (attempt < MAX_RETRIES - 1) {
        this.stats.retries++;
        return this._retryRequest(rpcBody, attempt + 1);
      }

      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32603, message: `All retries exhausted: ${err.message}` } };
    }
  }

  async _raceRequest(rpcBody) {
    const providers = this.health.providers;
    const targets = this.strategy.select(providers, this.health);

    if (!targets || targets.length === 0) {
      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32000, message: 'No healthy providers available' } };
    }

    try {
      const result = await Promise.any(targets.map(p => this._sendToProvider(p, rpcBody)));
      this.stats.success++;
      return result;
    } catch (err) {
      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32603, message: 'All race candidates failed' } };
    }
  }

  async _sendToProvider(provider, rpcBody) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcBody),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  getStats() {
    return { ...this.stats, strategy: this.strategyName };
  }
}

module.exports = { Router };
