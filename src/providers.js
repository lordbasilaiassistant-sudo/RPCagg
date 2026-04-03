/**
 * RPC Provider Registry
 * Add/remove/configure Base mainnet RPC endpoints here.
 * Each provider has a name, url, weight (higher = preferred), and per-provider limits.
 */

const BASE_CHAIN_ID = 8453;

const providers = [
  // Tier 1 — reliable, high limits
  { name: 'base-official',  url: 'https://mainnet.base.org',                               weight: 10, maxConcurrent: 15 },
  { name: 'ankr',           url: 'https://rpc.ankr.com/base',                              weight: 8,  maxConcurrent: 12 },
  { name: 'publicnode',     url: 'https://base-rpc.publicnode.com',                         weight: 8,  maxConcurrent: 8  },
  { name: 'blast-api',      url: 'https://base-mainnet.public.blastapi.io',                weight: 8,  maxConcurrent: 10 },
  { name: 'llamanodes',     url: 'https://base.llamarpc.com',                              weight: 8,  maxConcurrent: 10 },
  { name: 'drpc',           url: 'https://base.drpc.org',                                  weight: 7,  maxConcurrent: 10 },

  // Tier 2 — good, moderate limits
  { name: 'blockpi',        url: 'https://base.blockpi.network/v1/rpc/public',             weight: 7,  maxConcurrent: 8  },
  { name: '1rpc',           url: 'https://1rpc.io/base',                                   weight: 6,  maxConcurrent: 8  },
  { name: 'lavanet',        url: 'https://base.lava.build',                                weight: 6,  maxConcurrent: 8  },
  { name: 'meowrpc',        url: 'https://base.meowrpc.com',                               weight: 5,  maxConcurrent: 6  },
  { name: 'thirdweb',       url: 'https://base.rpc.thirdweb.com',                          weight: 5,  maxConcurrent: 6  },
  { name: 'nodies',         url: 'https://base-mainnet.nodies.app',                        weight: 5,  maxConcurrent: 6  },
  { name: 'tenderly',       url: 'https://base.gateway.tenderly.co',                       weight: 5,  maxConcurrent: 6  },

  // Tier 3 — usable, lower limits or less reliable
  { name: 'publicnode-alt', url: 'https://base.publicnode.com',                             weight: 5,  maxConcurrent: 6  },
  { name: 'unifra',         url: 'https://base-mainnet.unifra.io',                         weight: 4,  maxConcurrent: 5  },
  { name: 'stackup',        url: 'https://public.stackup.sh/api/v1/node/base-mainnet',    weight: 4,  maxConcurrent: 5  },
  { name: 'chainnodes',     url: 'https://base-mainnet.chainnodes.org',                    weight: 4,  maxConcurrent: 5  },
  { name: 'allnodes',       url: 'https://base-mainnet-rpc.allthatnode.com',               weight: 4,  maxConcurrent: 5  },
  { name: 'tatum',          url: 'https://base-mainnet.gateway.tatum.io',                  weight: 3,  maxConcurrent: 4  },
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
