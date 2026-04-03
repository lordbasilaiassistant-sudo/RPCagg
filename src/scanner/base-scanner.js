/**
 * BaseScanner — abstract base class for all scanner modules.
 * Handles: lifecycle, checkpointing, stats, logging, and rate-aware pacing.
 */

const { makeLogger } = require('../logger');
const { Checkpoint } = require('./checkpoint');

class BaseScanner {
  constructor(name, rpcClient) {
    this.name = name;
    this.rpc = rpcClient;
    this.log = makeLogger(name);
    this.checkpoint = new Checkpoint(name);
    this.running = false;
    this.stats = { processed: 0, errors: 0, startedAt: null, lastActivity: null };
  }

  // Override in subclass — the actual scan logic
  async scan() {
    throw new Error(`${this.name}.scan() not implemented`);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = new Date().toISOString();
    this.log.info(`starting`);

    try {
      await this.scan();
    } catch (err) {
      this.log.error(`crashed: ${err.message}`);
      this.stats.errors++;
    } finally {
      this.running = false;
      this.log.info(`stopped`, this.getStats());
    }
  }

  stop() {
    this.running = false;
  }

  recordProgress(count = 1) {
    this.stats.processed += count;
    this.stats.lastActivity = new Date().toISOString();
  }

  getStats() {
    return {
      name: this.name,
      running: this.running,
      ...this.stats,
      checkpoint: { lastBlock: this.checkpoint.lastBlock },
    };
  }
}

module.exports = { BaseScanner };
