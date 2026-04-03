/**
 * RPC Aggregator Server
 * Exposes a local JSON-RPC endpoint that proxies to the best available Base RPC.
 */

const express = require('express');
const { makeLogger } = require('./logger');
const log = makeLogger('server');

const MAX_INFLIGHT = parseInt(process.env.MAX_INFLIGHT || '200', 10);
const MAX_BATCH = parseInt(process.env.MAX_BATCH || '500', 10);

// Allowed RPC methods — blocks admin/debug/personal by default.
// Deep scanning methods (debug_*, trace_*) enabled via env flag.
const ALLOWED_METHODS = new Set([
  // Standard read methods
  'eth_blockNumber', 'eth_chainId', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
  'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionByBlockHashAndIndex',
  'eth_getUncleByBlockHashAndIndex', 'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash', 'eth_getUncleCountByBlockNumber',
  'eth_getLogs', 'eth_getProof', 'eth_getBlockReceipts',
  // Call/estimate (read-only simulation)
  'eth_call', 'eth_estimateGas', 'eth_createAccessList',
  // Network info
  'net_version', 'net_listening', 'net_peerCount',
  'web3_clientVersion', 'web3_sha3',
  // Filter methods
  'eth_newFilter', 'eth_newBlockFilter', 'eth_newPendingTransactionFilter',
  'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter',
]);

// Deep scanning methods — enabled with ENABLE_DEEP=1
const DEEP_METHODS = new Set([
  'debug_traceTransaction', 'debug_traceBlockByNumber', 'debug_traceBlockByHash',
  'debug_traceCall', 'debug_storageRangeAt',
  'trace_block', 'trace_transaction', 'trace_replayBlockTransactions',
  'trace_replayTransaction', 'trace_filter', 'trace_call',
]);

if (process.env.ENABLE_DEEP === '1') {
  for (const m of DEEP_METHODS) ALLOWED_METHODS.add(m);
}

// Also allow eth_sendRawTransaction if explicitly enabled
if (process.env.ENABLE_SEND === '1') {
  ALLOWED_METHODS.add('eth_sendRawTransaction');
}

function validateRpcRequest(body) {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  if (!body.jsonrpc || !body.method) return 'Missing jsonrpc or method field';
  if (typeof body.method !== 'string') return 'Method must be a string';
  if (!ALLOWED_METHODS.has(body.method)) return `Method not allowed: ${body.method}`;
  return null;
}

function createServer(router, healthChecker) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  let inflight = 0;
  let rejected = 0;

  // Backpressure middleware
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/') {
      if (inflight >= MAX_INFLIGHT) {
        rejected++;
        return res.status(503).json({
          jsonrpc: '2.0', id: null,
          error: { code: -32000, message: 'Server overloaded' },
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

    // Batch requests
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) {
        return res.status(400).json({
          jsonrpc: '2.0', id: null,
          error: { code: -32600, message: `Batch too large (max ${MAX_BATCH})` },
        });
      }
      // Validate each item
      for (const item of body) {
        const err = validateRpcRequest(item);
        if (err) {
          return res.status(400).json({
            jsonrpc: '2.0', id: item?.id || null,
            error: { code: -32600, message: err },
          });
        }
      }
      const results = await Promise.all(body.map(r => router.forwardRequest(r)));
      return res.json(results);
    }

    // Single request
    const err = validateRpcRequest(body);
    if (err) {
      return res.status(400).json({
        jsonrpc: '2.0', id: body?.id || null,
        error: { code: -32600, message: err },
      });
    }

    const result = await router.forwardRequest(body);
    res.json(result);
  });

  // Health/status endpoints (GET only, no sensitive data)
  app.get('/health', (req, res) => {
    const available = healthChecker.getAvailable();
    res.json({
      status: available.length > 0 ? 'ok' : 'degraded',
      availableProviders: available.length,
      totalProviders: healthChecker.providers.length,
      inflight,
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

  // Strategy switching — only from localhost
  app.post('/strategy/:name', (req, res) => {
    try {
      router.setStrategy(req.params.name);
      res.json({ ok: true, strategy: req.params.name });
    } catch (err) {
      res.status(400).json({ ok: false, error: 'Invalid strategy name' });
    }
  });

  // List allowed methods
  app.get('/methods', (req, res) => {
    res.json([...ALLOWED_METHODS].sort());
  });

  return app;
}

module.exports = { createServer, ALLOWED_METHODS };
