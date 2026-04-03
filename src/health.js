/**
 * Health Checker
 * Background process that pings each RPC provider, tracks latency + uptime,
 * marks providers healthy/unhealthy, and manages rate limit cooldowns.
 */

const { makeLogger } = require('./logger');
const log = makeLogger('health');

const HEALTH_INTERVAL_MS = 10_000;       // check every 10s
const UNHEALTHY_THRESHOLD_MS = 5_000;    // >5s response = unhealthy
const CONSECUTIVE_FAILURES = 3;          // 3 fails in a row = mark down
const RECOVERY_SUCCESSES = 2;            // 2 successes to recover
const RATE_LIMIT_COOLDOWN_MS = 30_000;   // 30s cooldown after 429
const RATE_LIMIT_BACKOFF_MULT = 2;       // exponential backoff multiplier
const MAX_COOLDOWN_MS = 300_000;         // max 5 min cooldown
const LATENCY_EWMA_ALPHA = 0.3;         // smoothing factor for latency tracking

class HealthChecker {
  constructor(providers) {
    this.providers = providers;
    this.state = new Map();
    this._interval = null;

    for (const p of providers) {
      this.state.set(p.name, {
        healthy: true,
        latency: Infinity,
        smoothedLatency: Infinity,
        failures: 0,
        recoveries: 0,
        lastCheck: 0,
        totalRequests: 0,
        totalErrors: 0,
        totalSuccess: 0,
        // Rate limit tracking
        rateLimited: false,
        rateLimitUntil: 0,       // timestamp when cooldown expires
        rateLimitCount: 0,       // consecutive rate limits (for backoff)
        lastRateLimit: 0,
        // Concurrency tracking
        inflight: 0,
        maxConcurrent: p.maxConcurrent || 10,
        // Block height tracking (stale data detection)
        lastBlockNumber: 0,
        blockLag: 0,
      });
    }
  }

  async checkOne(provider) {
    const s = this.state.get(provider.name);
    const start = Date.now();

    // Skip if in rate limit cooldown
    if (s.rateLimited && Date.now() < s.rateLimitUntil) {
      log.debug(`skipping check: ${provider.name} (rate limited until ${new Date(s.rateLimitUntil).toISOString()})`);
      return;
    }

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

      // Rate limit detection
      if (res.status === 429) {
        this._handleRateLimit(provider, s);
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);

      const latency = Date.now() - start;
      s.latency = latency;
      s.smoothedLatency = s.smoothedLatency === Infinity
        ? latency
        : s.smoothedLatency * (1 - LATENCY_EWMA_ALPHA) + latency * LATENCY_EWMA_ALPHA;
      s.totalRequests++;
      s.totalSuccess++;
      s.lastCheck = Date.now();

      // Track block height for stale detection
      if (json.result) {
        s.lastBlockNumber = parseInt(json.result, 16);
      }

      // Clear rate limit state on success
      if (s.rateLimited) {
        s.rateLimited = false;
        s.rateLimitCount = 0;
        log.info(`rate limit cleared: ${provider.name}`);
      }

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

  _handleRateLimit(provider, s) {
    s.rateLimited = true;
    s.rateLimitCount++;
    s.lastRateLimit = Date.now();

    // Exponential backoff: 30s, 60s, 120s, 240s, capped at 300s
    const cooldown = Math.min(
      RATE_LIMIT_COOLDOWN_MS * Math.pow(RATE_LIMIT_BACKOFF_MULT, s.rateLimitCount - 1),
      MAX_COOLDOWN_MS
    );
    s.rateLimitUntil = Date.now() + cooldown;

    log.warn(`rate limited: ${provider.name}`, {
      cooldown: `${(cooldown / 1000).toFixed(0)}s`,
      consecutive: s.rateLimitCount,
    });
  }

  // Called by router when a request gets rate limited
  recordRateLimit(providerName) {
    const s = this.state.get(providerName);
    if (!s) return;
    this._handleRateLimit({ name: providerName }, s);
  }

  // Called by router to record request latency from actual traffic
  recordLatency(providerName, latency) {
    const s = this.state.get(providerName);
    if (!s) return;
    s.smoothedLatency = s.smoothedLatency === Infinity
      ? latency
      : s.smoothedLatency * (1 - LATENCY_EWMA_ALPHA) + latency * LATENCY_EWMA_ALPHA;
    s.latency = latency;
    s.totalRequests++;
    s.totalSuccess++;
  }

  // Called by router to record a failure
  recordFailure(providerName) {
    const s = this.state.get(providerName);
    if (!s) return;
    s.totalRequests++;
    s.totalErrors++;
    s.failures++;
  }

  // Check if a provider is available (healthy + not rate limited + not overloaded)
  isAvailable(providerName) {
    const s = this.state.get(providerName);
    if (!s) return false;
    if (!s.healthy) return false;
    if (s.rateLimited && Date.now() < s.rateLimitUntil) return false;
    if (s.inflight >= s.maxConcurrent) return false;
    return true;
  }

  // Get all available providers (healthy + not rate limited + not overloaded)
  getAvailable() {
    return this.providers.filter(p => this.isAvailable(p.name));
  }

  // Legacy — still used by strategies
  getHealthy() {
    return this.getAvailable();
  }

  acquireSlot(providerName) {
    const s = this.state.get(providerName);
    if (!s) return false;
    if (s.inflight >= s.maxConcurrent) return false;
    s.inflight++;
    return true;
  }

  releaseSlot(providerName) {
    const s = this.state.get(providerName);
    if (!s) return;
    s.inflight = Math.max(0, s.inflight - 1);
  }

  async checkAll() {
    // Also compute block lag across providers
    await Promise.allSettled(this.providers.map(p => this.checkOne(p)));

    // Compute max block across all providers
    let maxBlock = 0;
    for (const [, s] of this.state) {
      if (s.lastBlockNumber > maxBlock) maxBlock = s.lastBlockNumber;
    }
    for (const [name, s] of this.state) {
      s.blockLag = s.lastBlockNumber > 0 ? maxBlock - s.lastBlockNumber : -1;
      // Mark providers >5 blocks behind as potentially stale
      if (s.blockLag > 5 && s.healthy) {
        log.warn(`stale: ${name}`, { blockLag: s.blockLag, block: s.lastBlockNumber, head: maxBlock });
      }
    }
  }

  start() {
    if (this._interval) return;
    log.info(`starting health checks for ${this.providers.length} providers`);
    this.checkAll();
    this._interval = setInterval(() => this.checkAll(), HEALTH_INTERVAL_MS);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getStats() {
    const stats = {};
    for (const [name, s] of this.state) {
      stats[name] = {
        healthy: s.healthy,
        available: this.isAvailable(name),
        latency: s.latency === Infinity ? null : s.latency,
        smoothedLatency: s.smoothedLatency === Infinity ? null : Math.round(s.smoothedLatency),
        inflight: s.inflight,
        rateLimited: s.rateLimited,
        rateLimitUntil: s.rateLimited ? new Date(s.rateLimitUntil).toISOString() : null,
        blockLag: s.blockLag,
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
