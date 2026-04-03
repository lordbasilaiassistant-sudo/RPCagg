/**
 * Price Tokens — Run DexPricer + TokenDiscovery on funded contracts from treasure scan.
 *
 * For each contract with ETH > 0 in our scan, discovers ALL tokens and prices them
 * via DEX pair reserves. Outputs total value (ETH + tokens) per contract.
 */

const fs = require('fs');
const path = require('path');
const { RpcClient, TokenDiscovery, DexPricer } = require('../src/scanner');

async function main() {
  const rpc = new RpcClient('http://127.0.0.1:8545');

  // Check aggregator health
  const health = await rpc.checkHealth();
  console.log(`Aggregator: ${health.status} (${health.availableProviders}/${health.totalProviders} providers)\n`);
  if (health.status !== 'ok') {
    console.error('Aggregator not healthy. Start with: node index.js');
    process.exit(1);
  }

  const discovery = new TokenDiscovery(rpc);
  const pricer = new DexPricer(rpc);

  // Get ETH/USD price
  const ethUsd = await pricer.getEthUsdPrice();
  console.log(`ETH/USD: $${ethUsd ? ethUsd.toFixed(2) : 'unknown'}\n`);

  // Load treasure data
  const treasurePath = path.join(__dirname, '..', 'data', 'treasure-1950000-2050000.json');
  const treasureData = JSON.parse(fs.readFileSync(treasurePath, 'utf-8'));

  // Get all funded contracts (ETH > 0)
  const funded = treasureData.treasures.filter(t => {
    const eth = parseFloat(t.ethBalance) || 0;
    return eth > 0;
  });

  console.log(`Found ${funded.length} funded contracts to analyze\n`);
  console.log('='.repeat(80));

  const results = [];

  for (const contract of funded) {
    const addr = contract.address;
    const ethBal = parseFloat(contract.ethBalance) || 0;

    console.log(`\n${addr}`);
    console.log(`  ETH balance: ${ethBal.toFixed(6)} ETH`);

    // Discover tokens
    let tokens;
    try {
      tokens = await discovery.discover(addr, {
        fromBlock: contract.blockNumber,
        toBlock: 'latest',
      });
    } catch (err) {
      console.log(`  Token discovery failed: ${err.message}`);
      tokens = {};
    }

    const tokenCount = Object.keys(tokens).length;
    let totalTokenEthValue = 0;
    const tokenValues = [];

    if (tokenCount > 0) {
      console.log(`  Tokens held: ${tokenCount}`);

      // Price each token
      for (const [tokenAddr, info] of Object.entries(tokens)) {
        const val = await pricer.valueInEth(tokenAddr, info.balance, info.decimals);
        if (val && val.ethValue > 0.0001) {
          totalTokenEthValue += val.ethValue;
          const usdStr = val.usdValue ? ` ($${val.usdValue.toFixed(2)})` : '';
          console.log(`    ${info.symbol}: ${info.balanceFormatted} = ${val.ethValue.toFixed(6)} ETH${usdStr} [${val.source}]`);
          tokenValues.push({
            token: tokenAddr,
            symbol: info.symbol,
            balance: info.balanceFormatted,
            ethValue: val.ethValue,
            usdValue: val.usdValue,
            source: val.source,
          });
        } else if (val === null) {
          console.log(`    ${info.symbol}: ${info.balanceFormatted} (no DEX pair — unpriced)`);
        }
      }
    } else {
      console.log(`  No tokens found`);
    }

    const totalEthValue = ethBal + totalTokenEthValue;
    const totalUsdValue = ethUsd ? totalEthValue * ethUsd : null;
    const usdStr = totalUsdValue ? ` ($${totalUsdValue.toFixed(2)})` : '';

    console.log(`  TOTAL VALUE: ${totalEthValue.toFixed(6)} ETH${usdStr}`);

    results.push({
      contract: addr,
      deployer: contract.deployer,
      ethBalance: ethBal,
      tokensFound: tokenCount,
      tokenValues,
      totalTokenEthValue,
      totalEthValue,
      totalUsdValue,
      isProxy: contract.isProxy,
      hasSelfdestruct: contract.hasSelfdestruct,
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n=== FINAL RANKINGS ===\n');

  results.sort((a, b) => b.totalEthValue - a.totalEthValue);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const usdStr = r.totalUsdValue ? ` ($${r.totalUsdValue.toFixed(2)})` : '';
    const tokenStr = r.totalTokenEthValue > 0 ? ` [${r.tokensFound} tokens = ${r.totalTokenEthValue.toFixed(6)} ETH]` : '';
    console.log(`  #${i + 1} ${r.contract}: ${r.totalEthValue.toFixed(6)} ETH${usdStr}${tokenStr}`);
  }

  // Summary
  const totalEth = results.reduce((s, r) => s + r.totalEthValue, 0);
  const totalUsd = ethUsd ? totalEth * ethUsd : null;
  const usdTotal = totalUsd ? ` ($${totalUsd.toFixed(2)})` : '';
  console.log(`\nTOTAL ACROSS ALL CONTRACTS: ${totalEth.toFixed(6)} ETH${usdTotal}`);
  console.log(`Pricer stats: ${JSON.stringify(pricer.getStats())}`);

  // Write results
  const outPath = path.join(__dirname, '..', 'data', 'token-valuations.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ethUsd: ethUsd,
    contractsAnalyzed: results.length,
    totalEthValue: totalEth,
    totalUsdValue: totalUsd,
    contracts: results,
  }, null, 2));

  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
