# RPCagg

AIO RPC aggregator that funnels 20+ Base mainnet RPCs into one local endpoint, with a chain scanner and neural network for autonomous on-chain value discovery.

## The Science

### 1. RPC Aggregation Layer

Public RPC endpoints are unreliable individually — rate limits, latency spikes, stale data. This system treats 19 providers as a single fault-tolerant endpoint using three routing strategies:

- **Fastest** — weighted latency scoring with EWMA smoothing and inflight-count penalty. Providers with the lowest `(smoothedLatency + inflight * 50) / weight` score get traffic.
- **Round Robin** — weighted distribution across healthy providers for even load.
- **Race** — fires at the top 3 providers simultaneously, returns the first response (lowest latency at the cost of 3x bandwidth).

Rate limit detection uses exponential backoff (`30s * 2^n`, capped at 5min). A provider returning HTTP 429 is immediately excluded from routing and cooled down. Retries never re-select the same provider (exclusion set propagated across attempts).

### 2. Chain Scanner

The scanner treats the aggregator as a black box (`http://localhost:8545`) and implements backpressure-aware scanning:

- **Block Scanner** — crawls blocks in parallel batches (50 blocks x 5 concurrent), extracts headers and contract deployments (tx.to === null).
- **Contract Scanner** — fetches bytecode via `eth_getCode`, extracts function selectors from PUSH4/EQ patterns, classifies proxy types by reading EIP-1967 storage slots (`implementation`, `admin`, `beacon`), detects EIP-1167 minimal proxies from bytecode prefixes, and flags CREATE/CREATE2 factories.
- **Executor** — simulates extraction calls via `eth_call` (zero gas cost), estimates actual gas via `eth_estimateGas`, calculates `profit = contractValue - gasCost`, and optionally executes live with post-execution receipt verification and balance diff confirmation.

### 3. Feature Vectorization

Every analyzed contract is compressed into a 35-dimensional feature vector:

| Dims | Group | Features |
|------|-------|----------|
| 0-9 | Structural | code size, destroyed, proxy type, factory, selfdestruct, selector count, deploy gas, block age |
| 10-16 | Financial | log-normalized ETH/WETH/USDC/USDbC/DAI balances, has-value flags |
| 17-30 | Capability | coverage ratios across 14 selector categories (transfer, withdraw, swap, governance, admin, emergency, upgrade, sweep, mint, burn, pause, claim, deposit, liquidity) |
| 31-34 | Extraction | simulation success rate, extraction success rate, successful sim count, treasure label |

Financial values use `log10(x+1)/10` normalization to compress the extreme range (0 wei to billions of ETH) into [0,1]. Structural features use min-max normalization. Capability features are coverage ratios naturally bounded [0,1].

### 4. TreasureNet (Neural Network)

A 128K-parameter multi-task PyTorch model with 4 heads sharing a common encoder:

**Encoder**: 4 semantic feature-group encoders (structural, financial, capability, extraction) each project their subset into 32 dims, concatenated to 128-dim, processed through 3 residual blocks with LayerNorm and GELU activation.

**Heads**:
1. **Anomaly Detection** — autoencoder reconstruction. Anomaly score = reconstruction error amplified by treasure/extraction probability. Self-calibrating threshold at the 95th percentile of a rolling window.
2. **Value Prediction** — regresses log(ETH+1) with Softplus output and LogCosh loss (robust to outliers from whale contracts).
3. **Extraction Success** — binary classification with AsymmetricLoss (gamma_neg=4.0) for aggressive negative suppression.
4. **Treasure Classification** — binary with AsymmetricLoss (gamma_neg=6.0, clip=0.02). Decision threshold at 0.20 (not 0.50) to minimize false negatives.

**Class imbalance handling** (5 mechanisms): AsymmetricLoss with separate gamma for positives vs negatives, oversampling via ImbalancedSampler (up to 10x), SMOTE-like synthetic positive generation, output bias initialization to log(0.01/0.99), and task loss weighting (treasure=5x, extraction=3x, value=2x, reconstruction=1x).

Inference: ~4.7ms per contract on CPU. Designed for real-time classification of every new contract deployment on Base.

## Usage

```bash
# Start the aggregator
npm start

# Run tests
npm test

# Scan blocks for contracts
node scan.js blocks

# Hunt for extractable value
node treasure-hunt.js 1950000 2050000

# Train the model (after collecting vectors)
python ml/model.py train --data data/vectors-*.jsonl
```

## Architecture

```
src/
  config.js              Central configuration
  providers.js           19 Base RPC endpoints (tiered by reliability)
  health.js              Health checker + rate limit cooldown + stale detection
  router.js              Request routing + retry with exclusion sets
  server.js              Express JSON-RPC proxy + method allowlist
  strategies/            Pluggable routing (fastest, round-robin, race)
  scanner/
    rpc-client.js        Backpressure-aware RPC client
    block-scanner.js     Parallel block crawler
    contract-scanner.js  Bytecode classifier + proxy detector
    executor.js          Sim -> profit check -> execute -> verify
    vectorizer.js        35-dim feature vector compression
    checkpoint.js        Resume-from-checkpoint persistence
ml/
  model.py               TreasureNet PyTorch model
```
