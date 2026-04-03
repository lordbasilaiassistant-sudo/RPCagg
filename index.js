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

const config = require('./src/config');
const { providers } = require('./src/providers');
const { HealthChecker } = require('./src/health');
const { Router } = require('./src/router');
const { createServer } = require('./src/server');
const { makeLogger, setLevel } = require('./src/logger');

const log = makeLogger('main');

setLevel(config.logLevel);

log.info(`RPC Aggregator starting`);
log.info(`providers: ${providers.length} | strategy: ${config.strategy} | port: ${config.port}`);

const healthChecker = new HealthChecker(providers);
const router = new Router(healthChecker, config.strategy);
const app = createServer(router, healthChecker);

healthChecker.start();

const server = app.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}`);
  log.info(`status: http://localhost:${config.port}/health`);
  log.info(`stats:  http://localhost:${config.port}/stats`);
});

// Graceful shutdown
function shutdown() {
  log.info('shutting down...');
  healthChecker.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Export for programmatic use in other projects
module.exports = { healthChecker, router, app, config };
