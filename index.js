/**
 * RPC Aggregator — Entry Point
 *
 * Spins up a local JSON-RPC proxy on port 8545 (default) that
 * load-balances across 20+ Base mainnet RPCs.
 *
 * Usage:
 *   node index.js                     # default: port 8545, strategy: fastest
 *   PORT=9545 STRATEGY=race node .    # custom port + race mode
 *
 * Then point your tools at: http://localhost:8545
 */

const { providers } = require('./src/providers');
const { HealthChecker } = require('./src/health');
const { Router } = require('./src/router');
const { createServer } = require('./src/server');
const { makeLogger, setLevel } = require('./src/logger');

const log = makeLogger('main');

const PORT = parseInt(process.env.PORT || '8545', 10);
const STRATEGY = process.env.STRATEGY || 'fastest';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

setLevel(LOG_LEVEL);

// Boot
log.info(`RPC Aggregator starting`);
log.info(`providers: ${providers.length} | strategy: ${STRATEGY} | port: ${PORT}`);

const healthChecker = new HealthChecker(providers);
const router = new Router(healthChecker, STRATEGY);
const app = createServer(router, healthChecker);

healthChecker.start();

const server = app.listen(PORT, () => {
  log.info(`listening on http://localhost:${PORT}`);
  log.info(`point ethers/viem/curl at http://localhost:${PORT}`);
  log.info(`status: http://localhost:${PORT}/health`);
  log.info(`stats:  http://localhost:${PORT}/stats`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('shutting down...');
  healthChecker.stop();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log.info('shutting down...');
  healthChecker.stop();
  server.close(() => process.exit(0));
});

// Export for programmatic use in other projects
module.exports = { healthChecker, router, app };
