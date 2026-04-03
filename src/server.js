/**
 * RPC Aggregator Server
 * Exposes a local JSON-RPC endpoint that proxies to the best available Base RPC.
 */

const express = require('express');
const { makeLogger } = require('./logger');
const log = makeLogger('server');

function createServer(router, healthChecker) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // JSON-RPC endpoint — this is what you point ethers/viem/curl at
  app.post('/', async (req, res) => {
    const body = req.body;

    // Handle batch requests (array of JSON-RPC calls)
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map(r => router.forwardRequest(r)));
      return res.json(results);
    }

    // Single request
    if (!body.jsonrpc || !body.method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: body.id || null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
      });
    }

    const result = await router.forwardRequest(body);
    res.json(result);
  });

  // Health/status endpoints for monitoring
  app.get('/health', (req, res) => {
    const healthy = healthChecker.getHealthy();
    res.json({
      status: healthy.length > 0 ? 'ok' : 'degraded',
      healthyProviders: healthy.length,
      totalProviders: healthChecker.providers.length,
    });
  });

  app.get('/stats', (req, res) => {
    res.json({
      router: router.getStats(),
      providers: healthChecker.getStats(),
    });
  });

  app.get('/providers', (req, res) => {
    res.json(healthChecker.getStats());
  });

  // Strategy switching
  app.post('/strategy/:name', (req, res) => {
    try {
      router.setStrategy(req.params.name);
      res.json({ ok: true, strategy: req.params.name });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return app;
}

module.exports = { createServer };
