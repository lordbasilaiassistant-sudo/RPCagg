/**
 * Health Checker
 * Background process that pings each RPC provider, tracks latency + uptime,
 * and marks providers healthy/unhealthy.
 */

const { makeLogger } = require('./logger');
const log = makeLogger('health');

const HEALTH_INTERVAL_MS = 15_000;       // check every 15s
const UNHEALTHY_THRESHOLD_MS = 5_000;    // >5s response = unhealthy
const CONSECUTIVE_FAILURES = 3;          // 3 fails in a row = mark down
const RECOVERY_SUCCESSES = 2;            // 2 successes to recover

class HealthChecker {
  constructor(providers) {
    this.providers = providers;
    this.state = new Map(); // name -> { healthy, latency, failures, recoveries, lastCheck }
    this._interval = null;

    for (const p of providers) {
      this.state.set(p.name, {
        healthy: true,
        latency: Infinity,
        failures: 0,
        recoveries: 0,
        lastCheck: 0,
        totalRequests: 0,
        totalErrors: 0,
      });
    }
  }

  async checkOne(provider) {
    const s = this.state.get(provider.name);
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UNHEALTHY_THRESHOLD_MS);

      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);

      const latency = Date.now() - start;
      s.latency = latency;
      s.totalRequests++;
      s.lastCheck = Date.now();

      if (!s.healthy) {
        s.recoveries++;
        if (s.recoveries >= RECOVERY_SUCCESSES) {
          s.healthy = true;
          s.failures = 0;
          s.recoveries = 0;
          log.info(`recovered: ${provider.name}`, { latency });
        }
      } else {
        s.failures = 0;
      }

      log.debug(`ok: ${provider.name}`, { latency });
    } catch (err) {
      s.totalRequests++;
      s.totalErrors++;
      s.failures++;
      s.recoveries = 0;
      s.latency = Infinity;
      s.lastCheck = Date.now();

      if (s.failures >= CONSECUTIVE_FAILURES && s.healthy) {
        s.healthy = false;
        log.warn(`down: ${provider.name}`, { error: err.message, failures: s.failures });
      } else {
        log.debug(`fail: ${provider.name}`, { error: err.message });
      }
    }
  }

  async checkAll() {
    await Promise.allSettled(this.providers.map(p => this.checkOne(p)));
  }

  start() {
    if (this._interval) return;
    log.info(`starting health checks for ${this.providers.length} providers`);
    this.checkAll(); // initial check
    this._interval = setInterval(() => this.checkAll(), HEALTH_INTERVAL_MS);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getHealthy() {
    return this.providers.filter(p => this.state.get(p.name).healthy);
  }

  getStats() {
    const stats = {};
    for (const [name, s] of this.state) {
      stats[name] = {
        healthy: s.healthy,
        latency: s.latency === Infinity ? null : s.latency,
        errorRate: s.totalRequests > 0
          ? ((s.totalErrors / s.totalRequests) * 100).toFixed(1) + '%'
          : '0%',
      };
    }
    return stats;
  }

  getState(name) {
    return this.state.get(name);
  }
}

module.exports = { HealthChecker };
