/**
 * BytecodeSimilarity — Fuzzy hash contracts by opcode skeleton.
 *
 * Core idea: Two contracts from the same Solidity source with different
 * constructor args have IDENTICAL opcode sequences but different PUSH operands.
 * Strip PUSH data, hash the opcode skeleton = fingerprint that matches across clones.
 *
 * If an exploit works on one contract, it works on ALL contracts with the same fingerprint.
 *
 * Approach:
 * 1. Parse bytecode into opcode stream (skip PUSH operands)
 * 2. Compute skeleton hash (SHA-256 of opcode-only stream)
 * 3. Compute n-gram fingerprint (set of 4-opcode sliding windows) for fuzzy matching
 * 4. Jaccard similarity between n-gram sets = fuzzy similarity score
 * 5. Group contracts into clusters by skeleton hash (exact) and n-gram similarity (fuzzy)
 *
 * Usage:
 *   const sim = new BytecodeSimilarity();
 *   sim.index(address, bytecodeHex);
 *   const similar = sim.findSimilar(address, threshold);
 *   sim.propagateFlag(address, 'exploitable', { reason: '...' });
 */

const crypto = require('crypto');
const { makeLogger } = require('../logger');
const log = makeLogger('bytecode-sim');

// N-gram window size for fuzzy matching
const NGRAM_SIZE = 4;
// Minimum opcodes to be indexable (skip tiny contracts)
const MIN_OPCODES = 10;

class BytecodeSimilarity {
  constructor() {
    // address -> { skeletonHash, ngrams: Set, opcodeCount, flags: {} }
    this._index = new Map();
    // skeletonHash -> Set<address> (exact match clusters)
    this._clusters = new Map();
    // address -> { flag, data } (propagated flags)
    this._flags = new Map();
  }

  /**
   * Index a contract's bytecode for similarity matching.
   * @param {string} address - Contract address
   * @param {string} bytecodeHex - Raw bytecode (with or without 0x prefix)
   * @returns {{ skeletonHash: string, opcodeCount: number, clusterSize: number }}
   */
  index(address, bytecodeHex) {
    const addr = address.toLowerCase();
    const hex = bytecodeHex.replace(/^0x/i, '').toLowerCase();

    if (hex.length < 4) return null;

    // Parse opcode skeleton
    const opcodes = extractOpcodes(hex);
    if (opcodes.length < MIN_OPCODES) return null;

    // Compute skeleton hash (exact match)
    const skeleton = Buffer.from(opcodes);
    const skeletonHash = crypto.createHash('sha256').update(skeleton).digest('hex').slice(0, 16);

    // Compute n-gram fingerprint (fuzzy match)
    const ngrams = computeNgrams(opcodes, NGRAM_SIZE);

    // Store in index
    const entry = { skeletonHash, ngrams, opcodeCount: opcodes.length, flags: {} };
    this._index.set(addr, entry);

    // Add to exact-match cluster
    if (!this._clusters.has(skeletonHash)) {
      this._clusters.set(skeletonHash, new Set());
    }
    this._clusters.get(skeletonHash).add(addr);

    // Propagate any existing flags from cluster members
    const cluster = this._clusters.get(skeletonHash);
    for (const member of cluster) {
      if (member === addr) continue;
      const memberFlags = this._flags.get(member);
      if (memberFlags) {
        this._flags.set(addr, { ...memberFlags, propagatedFrom: member });
        log.info(`flag propagated to ${addr} from cluster member ${member}`);
      }
    }

    return {
      skeletonHash,
      opcodeCount: opcodes.length,
      clusterSize: cluster.size,
    };
  }

  /**
   * Batch index from vectors JSONL data (uses code fetched separately).
   * @param {Array<{address: string, bytecode: string}>} contracts
   */
  indexBatch(contracts) {
    let indexed = 0;
    for (const c of contracts) {
      if (c.bytecode && this.index(c.address, c.bytecode)) {
        indexed++;
      }
    }
    log.info(`indexed ${indexed}/${contracts.length} contracts`);
    return indexed;
  }

  /**
   * Find contracts similar to a given address.
   * @param {string} address
   * @param {number} threshold - Jaccard similarity threshold (0-1), default 0.8
   * @returns {Array<{ address: string, similarity: number, matchType: string }>}
   */
  findSimilar(address, threshold = 0.8) {
    const addr = address.toLowerCase();
    const entry = this._index.get(addr);
    if (!entry) return [];

    const results = [];

    // 1. Exact skeleton matches (similarity = 1.0)
    const cluster = this._clusters.get(entry.skeletonHash);
    if (cluster) {
      for (const member of cluster) {
        if (member !== addr) {
          results.push({ address: member, similarity: 1.0, matchType: 'exact-skeleton' });
        }
      }
    }

    // 2. Fuzzy n-gram matches (if threshold < 1.0)
    if (threshold < 1.0) {
      for (const [otherAddr, otherEntry] of this._index) {
        if (otherAddr === addr) continue;
        if (otherEntry.skeletonHash === entry.skeletonHash) continue; // already in exact results

        const sim = jaccardSimilarity(entry.ngrams, otherEntry.ngrams);
        if (sim >= threshold) {
          results.push({ address: otherAddr, similarity: sim, matchType: 'fuzzy-ngram' });
        }
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Propagate a flag to all similar contracts.
   * When an exploit is found in one contract, flag all contracts
   * with the same skeleton hash + fuzzy matches above threshold.
   *
   * @param {string} address - Source contract where flag was discovered
   * @param {string} flag - Flag name (e.g., 'exploitable', 'honeypot', 'extractable')
   * @param {Object} data - Flag metadata (reason, exploit details, etc.)
   * @param {number} threshold - Similarity threshold for propagation (default 0.9)
   * @returns {number} Number of contracts flagged
   */
  propagateFlag(address, flag, data = {}, threshold = 0.9) {
    const addr = address.toLowerCase();

    // Flag the source
    this._flags.set(addr, { flag, data, source: true, propagatedAt: Date.now() });

    // Find all similar contracts
    const similar = this.findSimilar(addr, threshold);
    let flagged = 0;

    for (const match of similar) {
      const existing = this._flags.get(match.address);
      // Don't overwrite a directly-discovered flag with a propagated one
      if (existing && existing.source) continue;

      this._flags.set(match.address, {
        flag,
        data: { ...data, propagatedFrom: addr, similarity: match.similarity, matchType: match.matchType },
        source: false,
        propagatedAt: Date.now(),
      });
      flagged++;
    }

    if (flagged > 0) {
      log.info(`propagated "${flag}" from ${addr} to ${flagged} similar contracts`);
    }

    return flagged;
  }

  /**
   * Get all flagged contracts.
   */
  getFlagged(flagName) {
    const results = [];
    for (const [addr, flagData] of this._flags) {
      if (!flagName || flagData.flag === flagName) {
        results.push({ address: addr, ...flagData });
      }
    }
    return results;
  }

  /**
   * Get cluster statistics.
   */
  getStats() {
    const clusterSizes = [];
    for (const [hash, members] of this._clusters) {
      if (members.size > 1) {
        clusterSizes.push({ hash, size: members.size, sample: [...members].slice(0, 3) });
      }
    }
    clusterSizes.sort((a, b) => b.size - a.size);

    return {
      totalIndexed: this._index.size,
      totalClusters: this._clusters.size,
      multiMemberClusters: clusterSizes.length,
      totalFlagged: this._flags.size,
      largestClusters: clusterSizes.slice(0, 20),
    };
  }

  /**
   * Get the skeleton hash for an address (for external use).
   */
  getHash(address) {
    const entry = this._index.get(address.toLowerCase());
    return entry ? entry.skeletonHash : null;
  }

  /**
   * Export the full index as a serializable object.
   */
  export() {
    const entries = [];
    for (const [addr, entry] of this._index) {
      entries.push({
        address: addr,
        skeletonHash: entry.skeletonHash,
        opcodeCount: entry.opcodeCount,
        ngramCount: entry.ngrams.size,
        flags: this._flags.get(addr) || null,
      });
    }
    return {
      totalIndexed: this._index.size,
      entries,
      clusters: this.getStats().largestClusters,
    };
  }
}

// --- Opcode parsing ---

/**
 * Extract the opcode skeleton from EVM bytecode.
 * Walks the bytecode, records each opcode byte, and SKIPS
 * the operand bytes after PUSH instructions.
 *
 * This produces a sequence that is identical for contracts
 * compiled from the same source with different constructor args.
 *
 * @param {string} hex - Bytecode as hex string (no 0x prefix)
 * @returns {Uint8Array} - Opcode-only byte sequence
 */
function extractOpcodes(hex) {
  const opcodes = [];
  let i = 0;
  const len = hex.length;

  while (i < len - 1) {
    const opByte = parseInt(hex.substring(i, i + 2), 16);
    opcodes.push(opByte);

    if (opByte >= 0x60 && opByte <= 0x7f) {
      // PUSHn: skip the next n bytes of operand data
      const pushSize = opByte - 0x5f;
      i += 2 + pushSize * 2;
    } else {
      i += 2;
    }
  }

  return new Uint8Array(opcodes);
}

/**
 * Compute n-gram fingerprint from opcode sequence.
 * Each n-gram is a sliding window of N consecutive opcodes,
 * hashed to a 32-bit integer for fast set operations.
 *
 * @param {Uint8Array} opcodes
 * @param {number} n - Window size
 * @returns {Set<number>} - Set of n-gram hashes
 */
function computeNgrams(opcodes, n) {
  const ngrams = new Set();
  if (opcodes.length < n) return ngrams;

  for (let i = 0; i <= opcodes.length - n; i++) {
    // FNV-1a hash of the n-gram window
    let hash = 0x811c9dc5;
    for (let j = 0; j < n; j++) {
      hash ^= opcodes[i + j];
      hash = Math.imul(hash, 0x01000193);
    }
    ngrams.add(hash >>> 0); // unsigned 32-bit
  }

  return ngrams;
}

/**
 * Jaccard similarity between two n-gram sets.
 * |A intersect B| / |A union B|
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  // Iterate the smaller set for efficiency
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

module.exports = { BytecodeSimilarity, extractOpcodes, computeNgrams, jaccardSimilarity };
