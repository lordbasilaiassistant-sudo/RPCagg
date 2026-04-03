/**
 * RPC Client — the scanner's interface to the aggregator.
 * Handles batching, rate-aware throttling, retries, and backpressure.
 * All scanner modules use this instead of raw fetch.
 */

const { makeLogger } = require('../logger');
const log = makeLogger('rpc-client');

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 10;
const BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = 30000;

class RpcClient {
  constructor(url = 'http://127.0.0.1:8545') {
    this.url = url;
    this.stats = { calls: 0, batches: 0, errors: 0, retries: 0 };
    this._concurrency = DEFAULT_CONCURRENCY;
    this._inflight = 0;
  }

  // Single RPC call
  async call(method, params = []) {
    const body = { jsonrpc: '2.0', id: Date.now(), method, params };
    const result = await this._send(body);
    if (result.error) {
      throw new RpcError(result.error.message, result.error.code, method);
    }
    return result.result;
  }

  // Batch multiple calls, returns array of results
  async batch(calls) {
    if (calls.length === 0) return [];
    if (calls.length === 1) {
      try {
        const r = await this.call(calls[0].method, calls[0].params);
        return [r];
      } catch (err) {
        return [{ error: { message: err.message, code: err.code } }];
      }
    }

    const body = calls.map((c, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: c.method,
      params: c.params || [],
    }));

    this.stats.batches++;
    const results = await this._send(body);

    if (!Array.isArray(results)) {
      throw new RpcError('Batch response is not an array', -32603, 'batch');
    }

    // Sort by id to maintain order
    results.sort((a, b) => a.id - b.id);
    return results.map(r => {
      if (r.error) return { error: r.error };
      return r.result;
    });
  }

  // Batch with auto-chunking — splits large batches into safe sizes
  async batchChunked(calls, chunkSize = DEFAULT_BATCH_SIZE) {
    const results = [];
    for (let i = 0; i < calls.length; i += chunkSize) {
      const chunk = calls.slice(i, i + chunkSize);
      const chunkResults = await this.batch(chunk);
      results.push(...chunkResults);
    }
    return results;
  }

  // Parallel execution with concurrency limit
  async parallel(tasks, concurrency = this._concurrency) {
    const results = [];
    const executing = new Set();

    for (const task of tasks) {
      const p = Promise.resolve().then(() => task()).then(
        result => { executing.delete(p); return { ok: true, result }; },
        error => { executing.delete(p); return { ok: false, error: error.message }; }
      );
      executing.add(p);
      results.push(p);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  // Check aggregator health before starting heavy work
  async checkHealth() {
    try {
      const res = await fetch(`${this.url}/health`);
      return await res.json();
    } catch (err) {
      return { status: 'unreachable', error: err.message };
    }
  }

  // Get aggregator stats
  async getStats() {
    try {
      const res = await fetch(`${this.url}/stats`);
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  async _send(body, attempt = 0) {
    this.stats.calls++;
    this._inflight++;

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Server overloaded — back off
      if (res.status === 503) {
        if (attempt < 5) {
          const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
          log.debug(`aggregator overloaded, backing off ${delay}ms`);
          await sleep(delay);
          this.stats.retries++;
          return this._send(body, attempt + 1);
        }
        throw new RpcError('Aggregator overloaded after retries', -32000, 'send');
      }

      if (!res.ok) {
        throw new RpcError(`HTTP ${res.status}`, -32603, 'send');
      }

      return await res.json();
    } catch (err) {
      if (err instanceof RpcError) throw err;
      this.stats.errors++;
      throw new RpcError(err.message, -32603, 'send');
    } finally {
      this._inflight = Math.max(0, this._inflight - 1);
    }
  }

  getClientStats() {
    return { ...this.stats, inflight: Math.max(0, this._inflight) };
  }
}

class RpcError extends Error {
  constructor(message, code, method) {
    super(message);
    this.code = code;
    this.method = method;
    this.name = 'RpcError';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { RpcClient, RpcError };
