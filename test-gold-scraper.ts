/**
 * Quick test: verify gold scraper data sources work and prices are accurate.
 * Run with: npx ts-node test-gold-scraper.ts
 */

const TROY_OUNCE_GRAMS = 31.1035;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    console.error(`  FAIL fetchJson(${url}): ${(err as Error).message}`);
    return null;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.error(`  FAIL fetchHtml(${url}): ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  console.log('=== GOLD SCRAPER DATA SOURCE TEST ===\n');

  // Source 1: gold-api.com
  console.log('--- Source 1: api.gold-api.com (XAU/USD) ---');
  const goldApi = await fetchJson<{ price: number; symbol: string; currency: string; updatedAt: string }>(
    'https://api.gold-api.com/price/XAU'
  );
  if (goldApi?.price) {
    console.log(`  XAU/USD = $${goldApi.price}`);
    console.log(`  Updated: ${goldApi.updatedAt}`);
  } else {
    console.log('  FAILED - no price returned');
  }

  // Source 4: open.er-api.com (USD/EGP)
  console.log('\n--- Source 4: open.er-api.com (USD/EGP) ---');
  const fxApi = await fetchJson<{ rates: { EGP: number } }>(
    'https://open.er-api.com/v6/latest/USD'
  );
  if (fxApi?.rates?.EGP) {
    console.log(`  USD/EGP = ${fxApi.rates.EGP}`);
  } else {
    console.log('  FAILED - no EGP rate');
  }

  // Calculate prices if both sources work
  if (goldApi?.price && fxApi?.rates?.EGP) {
    const xauUsd = goldApi.price;
    const usdEgp = fxApi.rates.EGP;
    const xauEgp = xauUsd * usdEgp;
    const pricePerGram24K = xauEgp / TROY_OUNCE_GRAMS;

    console.log('\n=== CALCULATED GOLD PRICES (EGP) ===');
    console.log(`  XAU/EGP (per troy ounce): ${xauEgp.toFixed(2)} EGP`);
    console.log(`  24K per gram: ${pricePerGram24K.toFixed(2)} EGP`);
    console.log(`  21K per gram: ${(pricePerGram24K * 0.875).toFixed(2)} EGP`);
    console.log(`  18K per gram: ${(pricePerGram24K * 0.75).toFixed(2)} EGP`);
    console.log(`  14K per gram: ${(pricePerGram24K * 0.5833).toFixed(2)} EGP`);
    console.log(`  Gold Pound (8g of 21K + 3.5% premium): ${(pricePerGram24K * 0.875 * 8 * 1.035).toFixed(2)} EGP`);
    console.log(`  Gold Ounce (31.1g of 24K): ${(pricePerGram24K * 31.1035).toFixed(2)} EGP`);
    console.log(`  Gold Bar (24K/gram + 1% premium): ${(pricePerGram24K * 1.01).toFixed(2)} EGP/gram`);

    // Buy/sell with default 2% spread
    const sell21K = pricePerGram24K * 0.875;
    const buy21K = sell21K * 1.02;
    console.log(`\n  21K Buy (with 2% spread): ${buy21K.toFixed(2)} EGP`);
    console.log(`  21K Sell: ${sell21K.toFixed(2)} EGP`);
  }

  // Source 2: XE.com (cross-validation)
  console.log('\n--- Source 2: XE.com (XAU→EGP cross-validation) ---');
  const xeHtml = await fetchHtml('https://www.xe.com/currencyconverter/convert/?Amount=1&From=XAU&To=EGP');
  if (xeHtml) {
    const match = xeHtml.match(/1\s*XAU\s*=\s*([\d,]+\.?\d*)\s*EGP/i);
    if (match) {
      const xeRate = parseFloat(match[1].replace(/,/g, ''));
      console.log(`  XE XAU/EGP = ${xeRate.toFixed(2)} EGP`);
      if (goldApi?.price && fxApi?.rates?.EGP) {
        const calculated = goldApi.price * fxApi.rates.EGP;
        const diff = ((xeRate - calculated) / calculated * 100).toFixed(2);
        console.log(`  Calculated XAU/EGP = ${calculated.toFixed(2)} EGP`);
        console.log(`  Difference: ${diff}% ${Math.abs(parseFloat(diff)) < 2 ? '✓ ACCURATE' : '⚠ DIVERGENT'}`);
      }
    } else {
      console.log('  Could not parse XE rate from HTML');
    }
  }

  // Source 3: goldprice.org
  console.log('\n--- Source 3: goldprice.org (cross-validation) ---');
  const gpHtml = await fetchHtml('https://goldprice.org/gold-price-egypt.html');
  if (gpHtml) {
    // Try to find any EGP price
    const matches = gpHtml.match(/[\d,]+\.?\d*\s*(?:EGP|Egyptian)/gi);
    if (matches && matches.length > 0) {
      console.log(`  Found ${matches.length} EGP references`);
      console.log(`  First match: ${matches[0]}`);
    } else {
      console.log('  No EGP prices found in HTML (may be JS-rendered)');
    }
  }

  // Source 5: iSagha.com
  console.log('\n--- Source 5: iSagha.com (Egyptian dealer data) ---');
  const isaghaHtml = await fetchHtml('https://market.isagha.com/');
  if (isaghaHtml) {
    const text = isaghaHtml.replace(/<[^>]+>/g, ' ');
    // Look for karat patterns
    const karats = ['24', '21', '18', '14'];
    for (const k of karats) {
      const pattern = new RegExp(`عيار\\s*${k}[^\\d]*(\\d[\\d,]*\\.?\\d*)`, 'i');
      const m = text.match(pattern);
      if (m) {
        console.log(`  عيار ${k}: ${m[1]} EGP`);
      }
    }
    // Check if any price-like numbers exist
    const priceMatches = text.match(/\d{3,6}\.\d{2}/g);
    if (priceMatches) {
      console.log(`  Found ${priceMatches.length} price-like numbers in page`);
    } else {
      console.log('  No prices found (likely JS-rendered)');
    }
  }

  console.log('\n=== TEST COMPLETE ===');
}

main().catch(console.error);
