/**
 * RPC Router
 * Takes an incoming JSON-RPC request, selects a provider via strategy,
 * forwards the request, handles retries + failover.
 *
 * Key behaviors:
 * - Retries NEVER go back to the same provider that just failed
 * - 429 responses trigger immediate rate limit cooldown
 * - Per-provider concurrency slots prevent overloading
 * - Error classification: transient (retry) vs permanent (fail fast)
 */

const strategies = require('./strategies');
const { makeLogger } = require('./logger');
const log = makeLogger('router');

const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 10_000;

const PERMANENT_ERRORS = [
  'execution reverted',
  'invalid argument',
  'method not found',
  'invalid params',
  'block range too large',
];

class Router {
  constructor(healthChecker, strategyName = 'fastest') {
    this.health = healthChecker;
    this.setStrategy(strategyName);
    this.stats = { total: 0, success: 0, errors: 0, retries: 0, rateLimits: 0 };
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

    if (this.strategyName === 'race') {
      return this._raceRequest(rpcBody);
    }

    return this._retryRequest(rpcBody, 0, new Set());
  }

  async _retryRequest(rpcBody, attempt, excludeSet) {
    const providers = this.health.providers;
    const provider = this.strategy.select(providers, this.health, excludeSet);

    if (!provider) {
      this.stats.errors++;
      const excluded = excludeSet.size > 0 ? ` (${excludeSet.size} excluded)` : '';
      return {
        jsonrpc: '2.0',
        id: rpcBody.id || null,
        error: { code: -32000, message: `No healthy providers available${excluded}` },
      };
    }

    // Acquire concurrency slot
    if (!this.health.acquireSlot(provider.name)) {
      excludeSet.add(provider.name);
      if (attempt < MAX_RETRIES - 1) {
        return this._retryRequest(rpcBody, attempt, excludeSet);
      }
      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32000, message: 'All providers at capacity' } };
    }

    const { result, retryReason } = await this._attemptProvider(provider, rpcBody);
    this.health.releaseSlot(provider.name);

    if (result) return result;

    // Need to retry with a different provider
    excludeSet.add(provider.name);
    log.debug(`retrying: ${retryReason}`, { method: rpcBody.method, attempt });

    if (attempt < MAX_RETRIES - 1) {
      this.stats.retries++;
      return this._retryRequest(rpcBody, attempt + 1, excludeSet);
    }

    this.stats.errors++;
    log.warn(`all retries exhausted`, { method: rpcBody.method, reason: retryReason });
    return {
      jsonrpc: '2.0',
      id: rpcBody.id || null,
      error: { code: -32603, message: 'Request failed after all retries' },
    };
  }

  // Returns { result, retryReason }. If result is set, use it. If retryReason is set, retry.
  async _attemptProvider(provider, rpcBody) {
    try {
      const response = await this._sendToProvider(provider, rpcBody);
      const latency = response._latency || 0;
      delete response._latency;

      // Check for RPC-level errors
      if (response.error) {
        const msg = (response.error.message || '').toLowerCase();

        // Rate limit as RPC error
        if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many')) {
          this.health.recordRateLimit(provider.name);
          this.stats.rateLimits++;
          return { result: null, retryReason: 'rate limited (rpc)' };
        }

        // Permanent error — return as-is, don't retry
        if (PERMANENT_ERRORS.some(e => msg.includes(e))) {
          this.stats.errors++;
          return { result: response, retryReason: null };
        }

        // Unknown RPC error — return it (most are user errors like bad params)
        this.stats.success++;
        return { result: response, retryReason: null };
      }

      // Success
      this.stats.success++;
      this.health.recordLatency(provider.name, latency);
      log.debug(`routed to ${provider.name}`, { method: rpcBody.method });
      return { result: response, retryReason: null };

    } catch (err) {
      const errMsg = err.message || '';

      if (errMsg.includes('429')) {
        this.health.recordRateLimit(provider.name);
        this.stats.rateLimits++;
      } else {
        this.health.recordFailure(provider.name);
      }

      return { result: null, retryReason: errMsg };
    }
  }

  async _raceRequest(rpcBody) {
    const providers = this.health.providers;
    const targets = this.strategy.select(providers, this.health, new Set());

    if (!targets || targets.length === 0) {
      this.stats.errors++;
      return { jsonrpc: '2.0', id: rpcBody.id || null, error: { code: -32000, message: 'No healthy providers available' } };
    }

    try {
      const result = await Promise.any(
        targets.map(p =>
          this._sendToProvider(p, rpcBody).then(r => {
            delete r._latency;
            if (r.error) {
              const msg = (r.error.message || '').toLowerCase();
              if (msg.includes('rate') || msg.includes('limit')) {
                this.health.recordRateLimit(p.name);
                throw new Error('rate limited');
              }
            }
            return r;
          })
        )
      );
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
    const start = Date.now();

    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcBody),
        signal: controller.signal,
      });

      if (res.status === 429) throw new Error('HTTP 429');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      json._latency = Date.now() - start;
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  getStats() {
    return { ...this.stats, strategy: this.strategyName };
  }
}

module.exports = { Router };
