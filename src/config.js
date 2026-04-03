/**
 * Central configuration — all tunables in one place.
 * Override via environment variables.
 */

module.exports = {
  // Server
  port: parseInt(process.env.PORT || '8545', 10),
  host: process.env.HOST || '127.0.0.1',
  maxInflight: parseInt(process.env.MAX_INFLIGHT || '200', 10),
  maxBatch: parseInt(process.env.MAX_BATCH || '500', 10),

  // Router
  maxRetries: parseInt(process.env.MAX_RETRIES || '4', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
  strategy: process.env.STRATEGY || 'fastest',

  // Health
  healthIntervalMs: parseInt(process.env.HEALTH_INTERVAL_MS || '10000', 10),
  unhealthyThresholdMs: parseInt(process.env.UNHEALTHY_THRESHOLD_MS || '5000', 10),
  consecutiveFailures: parseInt(process.env.CONSECUTIVE_FAILURES || '3', 10),
  recoverySuccesses: parseInt(process.env.RECOVERY_SUCCESSES || '2', 10),
  rateLimitCooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || '30000', 10),
  rateLimitBackoffMult: parseFloat(process.env.RATE_LIMIT_BACKOFF_MULT || '2'),
  maxCooldownMs: parseInt(process.env.MAX_COOLDOWN_MS || '300000', 10),

  // Feature flags
  enableDeep: process.env.ENABLE_DEEP === '1',
  enableSend: process.env.ENABLE_SEND === '1',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Chain
  chainId: 8453,
  chainName: 'base',
};
