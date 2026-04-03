/**
 * RPC Provider Registry
 * Add/remove/configure Base mainnet RPC endpoints here.
 * Each provider has a name, url, and optional weight (higher = preferred).
 */

const BASE_CHAIN_ID = 8453;

const providers = [
  // -- Public RPCs --
  { name: 'base-official', url: 'https://mainnet.base.org', weight: 10 },
  { name: 'base-official-8453', url: 'https://base.meowrpc.com', weight: 5 },
  { name: 'ankr', url: 'https://rpc.ankr.com/base', weight: 8 },
  { name: 'publicnode', url: 'https://base-rpc.publicnode.com', weight: 8 },
  { name: 'blockpi', url: 'https://base.blockpi.network/v1/rpc/public', weight: 7 },
  { name: 'drpc', url: 'https://base.drpc.org', weight: 7 },
  { name: '1rpc', url: 'https://1rpc.io/base', weight: 6 },
  { name: 'lavanet', url: 'https://base.lava.build', weight: 6 },
  { name: 'unifra', url: 'https://base-mainnet.unifra.io', weight: 5 },
  { name: 'pokt', url: 'https://base-mainnet.gateway.pokt.network/v1/lb/dead', weight: 3 },
  { name: 'cloudflare-web3', url: 'https://base.gateway.tenderly.co', weight: 5 },
  { name: 'blast-api', url: 'https://base-mainnet.public.blastapi.io', weight: 7 },
  { name: 'thirdweb', url: 'https://base.rpc.thirdweb.com', weight: 5 },
  { name: 'llamanodes', url: 'https://base.llamarpc.com', weight: 7 },
  { name: 'base-sepolia-alt', url: 'https://base.meowrpc.com', weight: 4 },
  { name: 'stackup', url: 'https://public.stackup.sh/api/v1/node/base-mainnet', weight: 5 },
  { name: 'chainnodes', url: 'https://base-mainnet.chainnodes.org', weight: 5 },
  { name: 'superchain', url: 'https://mainnet.base.org', weight: 4 },
  { name: 'gitcoin', url: 'https://base.publicnode.com', weight: 6 },
  { name: 'nodies', url: 'https://base-mainnet.nodies.app', weight: 5 },
  { name: 'allnodes', url: 'https://base-mainnet-rpc.allthatnode.com', weight: 5 },
  { name: 'tatum', url: 'https://base-mainnet.gateway.tatum.io', weight: 4 },
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

module.exports = {
  BASE_CHAIN_ID,
  providers: uniqueProviders,
  addProvider(name, url, weight = 5) {
    uniqueProviders.push({ name, url, weight });
  },
  removeProvider(name) {
    const idx = uniqueProviders.findIndex(p => p.name === name);
    if (idx !== -1) uniqueProviders.splice(idx, 1);
  },
};
