/**
 * RPC Provider Registry
 * Add/remove/configure Base mainnet RPC endpoints here.
 * Each provider has a name, url, weight (higher = preferred), and per-provider limits.
 */

const BASE_CHAIN_ID = 8453;

const providers = [
  // Tier 1 — reliable, high limits, fast (<150ms)
  { name: 'base-official',    url: 'https://mainnet.base.org',                               weight: 10, maxConcurrent: 15 },
  { name: 'publicnode',       url: 'https://base-rpc.publicnode.com',                         weight: 8,  maxConcurrent: 8  },
  { name: 'blast-api',        url: 'https://base-mainnet.public.blastapi.io',                weight: 8,  maxConcurrent: 10 },
  { name: 'llamanodes',       url: 'https://base.llamarpc.com',                              weight: 8,  maxConcurrent: 10 },
  { name: 'drpc',             url: 'https://base.drpc.org',                                  weight: 7,  maxConcurrent: 10 },
  { name: 'base-dev',         url: 'https://developer-access-mainnet.base.org',              weight: 8,  maxConcurrent: 10 }, // NEW — Coinbase official alt, ~106ms
  { name: 'tenderly-pub',     url: 'https://gateway.tenderly.co/public/base',                weight: 8,  maxConcurrent: 10 }, // NEW — Tenderly public gateway, ~82ms, no key

  // Tier 2 — good, moderate limits
  { name: 'blockpi',          url: 'https://base.public.blockpi.network/v1/rpc/public',     weight: 7,  maxConcurrent: 8  }, // FIXED URL — old base.blockpi.network is dead (521)
  { name: '1rpc',             url: 'https://1rpc.io/base',                                   weight: 6,  maxConcurrent: 8  },
  { name: 'lavanet',          url: 'https://base.lava.build',                                weight: 6,  maxConcurrent: 8  },
  { name: 'meowrpc',          url: 'https://base.meowrpc.com',                               weight: 5,  maxConcurrent: 6  },
  { name: 'thirdweb',         url: 'https://base.rpc.thirdweb.com',                          weight: 5,  maxConcurrent: 6  },
  { name: 'tenderly',         url: 'https://base.gateway.tenderly.co',                       weight: 5,  maxConcurrent: 6  },
  { name: 'onfinality',       url: 'https://base.api.onfinality.io/public',                  weight: 6,  maxConcurrent: 8  }, // NEW — OnFinality, ~123ms, archive node, debug on paid
  { name: 'sequence',         url: 'https://nodes.sequence.app/base',                        weight: 7,  maxConcurrent: 8  }, // NEW — Sequence/Horizon, ~130ms, HAS debug_trace!
  { name: 'merkle',           url: 'https://base.merkle.io',                                 weight: 6,  maxConcurrent: 8  }, // NEW — Merkle, ~152ms, reliable
  { name: 'sentio',           url: 'https://rpc.sentio.xyz/base',                            weight: 5,  maxConcurrent: 6  }, // NEW — Sentio, ~158ms, debug on paid tier
  { name: 'nodies-public',    url: 'https://base-public.nodies.app',                         weight: 6,  maxConcurrent: 8  }, // NEW — Nodies public variant, ~170ms (replaces dead base-mainnet.nodies.app)
  { name: 'nodies-pokt',      url: 'https://base-pokt.nodies.app',                           weight: 6,  maxConcurrent: 8  }, // NEW — Nodies POKT-backed, ~170ms
  { name: 'bloxroute',        url: 'https://base.rpc.blxrbdn.com',                           weight: 6,  maxConcurrent: 6  }, // NEW — bloXroute, ~142ms, MEV-aware

  // Tier 3 — usable, higher latency or lower limits
  { name: 'publicnode-alt',   url: 'https://base.publicnode.com',                             weight: 5,  maxConcurrent: 6  },
  { name: 'subquery',         url: 'https://base.rpc.subquery.network/public',                weight: 5,  maxConcurrent: 6  }, // NEW — SubQuery decentralized, ~280ms
  { name: 'pocket',           url: 'https://base.api.pocket.network',                         weight: 5,  maxConcurrent: 6  }, // NEW — Pocket Network, ~320ms, no key, decentralized
  { name: 'polkachu',         url: 'https://base-rpc.polkachu.com',                           weight: 5,  maxConcurrent: 6  }, // NEW — Polkachu, ~320ms, community-run
  { name: 'zan',              url: 'https://api.zan.top/base-mainnet',                        weight: 4,  maxConcurrent: 5  }, // NEW — ZAN (Ant Group), ~1032ms, higher latency
  { name: 'particle',         url: 'https://rpc.particle.network/evm-chain/public?chainId=8453', weight: 4, maxConcurrent: 5 }, // NEW — Particle Network, ~522ms
  { name: 'tatum',            url: 'https://base-mainnet.gateway.tatum.io',                  weight: 3,  maxConcurrent: 4  },

  // DEAD/BROKEN — removed from active rotation (kept as comments for reference)
  // { name: 'ankr',        url: 'https://rpc.ankr.com/base',                  — BROKEN: returns 401 "must authenticate" (no longer free) },
  // { name: 'unifra',      url: 'https://base-mainnet.unifra.io',             — DEAD: no response },
  // { name: 'stackup',     url: 'https://public.stackup.sh/api/v1/node/base-mainnet', — DEAD: no response },
  // { name: 'chainnodes',  url: 'https://base-mainnet.chainnodes.org',        — DEAD: returns 404 },
  // { name: 'allnodes',    url: 'https://base-mainnet-rpc.allthatnode.com',   — DEAD: no response },
  // { name: 'nodies-old',  url: 'https://base-mainnet.nodies.app',            — DEAD: no response (replaced by base-public.nodies.app) },
];

// Deduplicate by URL (keep highest weight)
function deduplicateProviders(list) {
  const byUrl = new Map();
  for (const p of list) {
    const existing = byUrl.get(p.url);
    if (!existing || p.weight > existing.weight) {
      byUrl.set(p.url, p);
    }
  }
  return [...byUrl.values()];
}

const uniqueProviders = deduplicateProviders(providers);

function validateProviderUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Invalid protocol: ${parsed.protocol} (must be http/https)`);
    }
    // Block private/internal ranges
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
        host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.') ||
        host.startsWith('172.16.') || host.startsWith('172.17.') || host.startsWith('172.18.') ||
        host.startsWith('172.19.') || host.startsWith('172.2') || host.startsWith('172.30.') ||
        host.startsWith('172.31.') ||
        host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
      throw new Error(`Private/internal URL not allowed: ${host}`);
    }
    return true;
  } catch (err) {
    if (err.message.startsWith('Invalid') || err.message.startsWith('Private')) throw err;
    throw new Error(`Invalid URL: ${url}`);
  }
}

module.exports = {
  BASE_CHAIN_ID,
  providers: uniqueProviders,
  addProvider(name, url, weight = 5, maxConcurrent = 6) {
    validateProviderUrl(url);
    uniqueProviders.push({ name, url, weight, maxConcurrent });
  },
  removeProvider(name) {
    const idx = uniqueProviders.findIndex(p => p.name === name);
    if (idx !== -1) uniqueProviders.splice(idx, 1);
  },
};
