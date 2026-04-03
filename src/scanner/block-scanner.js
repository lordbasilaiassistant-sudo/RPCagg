/**
 * BlockScanner — crawls blocks and extracts core data.
 * Outputs: block headers, transaction list, contract deployments.
 * Other scanners consume BlockScanner output.
 */

const fs = require('fs');
const path = require('path');
const { BaseScanner } = require('./base-scanner');

const BATCH_SIZE = 10;          // blocks per batch
const CONCURRENCY = 5;          // parallel batch fetches
const CHECKPOINT_INTERVAL = 50; // save checkpoint every N blocks
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

class BlockScanner extends BaseScanner {
  constructor(rpcClient, opts = {}) {
    super('block-scanner', rpcClient);
    this.batchSize = opts.batchSize || BATCH_SIZE;
    this.concurrency = opts.concurrency || CONCURRENCY;
    this.onBlock = opts.onBlock || null;        // callback(blockData)
    this.onContracts = opts.onContracts || null; // callback(contracts[])
    this.direction = opts.direction || 'forward'; // 'forward' or 'backward'
  }

  async scan() {
    const head = parseInt(await this.rpc.call('eth_blockNumber'), 16);
    const startBlock = this.checkpoint.lastBlock || (head - 100); // default: last 100 blocks

    this.log.info(`head: ${head} | resuming from: ${startBlock} | direction: ${this.direction}`);

    if (this.direction === 'forward') {
      await this._scanForward(startBlock, head);
    } else {
      await this._scanBackward(startBlock);
    }
  }

  async _scanForward(from, to) {
    let current = from;

    while (this.running && current <= to) {
      const end = Math.min(current + this.batchSize * this.concurrency - 1, to);
      const blockNums = [];
      for (let i = current; i <= end; i++) blockNums.push(i);

      await this._processBlocks(blockNums);
      current = end + 1;

      // Check for new head
      if (current > to) {
        const newHead = parseInt(await this.rpc.call('eth_blockNumber'), 16);
        if (newHead > to) {
          to = newHead;
          this.log.info(`head advanced to ${newHead}, continuing`);
        }
      }
    }
  }

  async _scanBackward(from) {
    let current = from;

    while (this.running && current > 0) {
      const start = Math.max(current - this.batchSize * this.concurrency + 1, 0);
      const blockNums = [];
      for (let i = current; i >= start; i--) blockNums.push(i);

      await this._processBlocks(blockNums);
      current = start - 1;
    }
  }

  async _processBlocks(blockNums) {
    // Chunk into batches
    const chunks = [];
    for (let i = 0; i < blockNums.length; i += this.batchSize) {
      chunks.push(blockNums.slice(i, i + this.batchSize));
    }

    // Process chunks with concurrency limit
    const tasks = chunks.map(chunk => async () => {
      const calls = chunk.map(n => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${n.toString(16)}`, true], // full tx objects
      }));

      const results = await this.rpc.batch(calls);
      const contracts = [];

      for (let i = 0; i < results.length; i++) {
        const block = results[i];
        if (!block || block.error) {
          this.stats.errors++;
          continue;
        }

        // Extract contract deployments (tx.to === null)
        if (block.transactions) {
          for (const tx of block.transactions) {
            if (tx.to === null && typeof tx === 'object') {
              contracts.push({
                txHash: tx.hash,
                deployer: tx.from,
                blockNumber: parseInt(block.number, 16),
                timestamp: parseInt(block.timestamp, 16),
              });
            }
          }
        }

        if (this.onBlock) {
          await this.onBlock({
            number: parseInt(block.number, 16),
            hash: block.hash,
            timestamp: parseInt(block.timestamp, 16),
            txCount: block.transactions ? block.transactions.length : 0,
            gasUsed: parseInt(block.gasUsed, 16),
            baseFeePerGas: block.baseFeePerGas ? parseInt(block.baseFeePerGas, 16) : 0,
          });
        }

        this.recordProgress();
      }

      if (contracts.length > 0 && this.onContracts) {
        await this.onContracts(contracts);
      }

      return results;
    });

    await this.rpc.parallel(tasks, this.concurrency);

    // Update checkpoint to highest processed block
    const maxBlock = Math.max(...blockNums);
    if (maxBlock > this.checkpoint.lastBlock) {
      this.checkpoint.lastBlock = maxBlock;
    }
  }
}

module.exports = { BlockScanner };
