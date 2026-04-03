/**
 * Checkpoint — persist scan progress to disk so we can resume after restart.
 * Simple JSON file per scanner module.
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../logger');
const log = makeLogger('checkpoint');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

class Checkpoint {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(DATA_DIR, `${name}.checkpoint.json`);
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        log.info(`loaded checkpoint: ${this.name}`, { lastBlock: data.lastBlock });
        return data;
      }
    } catch (err) {
      log.warn(`failed to load checkpoint: ${this.name}`, { error: err.message });
    }
    return {};
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.error(`failed to save checkpoint: ${this.name}`, { error: err.message });
    }
  }

  get(key, defaultValue) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  set(key, value) {
    this.data[key] = value;
  }

  // Convenience for block-based scanners
  get lastBlock() { return this.data.lastBlock || 0; }
  set lastBlock(n) { this.data.lastBlock = n; this.save(); }
}

module.exports = { Checkpoint };
