/**
 * RPC Aggregator Server
 * Exposes a local JSON-RPC endpoint that proxies to the best available Base RPC.
 */

const express = require('express');
const { makeLogger } = require('./logger');
const log = makeLogger('server');

// Max concurrent requests the server will process (backpressure)
const MAX_INFLIGHT = parseInt(process.env.MAX_INFLIGHT || '200', 10);

function createServer(router, healthChecker) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  let inflight = 0;
  let rejected = 0;

  // Backpressure middleware — reject when overloaded
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/') {
      if (inflight >= MAX_INFLIGHT) {
        rejected++;
        return res.status(503).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: `Server overloaded (${inflight} inflight, max ${MAX_INFLIGHT})` },
        });
      }
      inflight++;
      res.on('finish', () => { inflight--; });
    }
    next();
  });

  // JSON-RPC endpoint
  app.post('/', async (req, res) => {
    const body = req.body;

    // Handle batch requests
    if (Array.isArray(body)) {
      if (body.length > 500) {
        return res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `Batch too large (${body.length}, max 500)` },
        });
      }
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

  // Health/status endpoints
  app.get('/health', (req, res) => {
    const available = healthChecker.getAvailable();
    res.json({
      status: available.length > 0 ? 'ok' : 'degraded',
      availableProviders: available.length,
      totalProviders: healthChecker.providers.length,
      inflight,
      maxInflight: MAX_INFLIGHT,
      rejected,
    });
  });

  app.get('/stats', (req, res) => {
    res.json({
      router: router.getStats(),
      server: { inflight, maxInflight: MAX_INFLIGHT, rejected },
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
