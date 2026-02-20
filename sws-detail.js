const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://simplywall.st/stocks/eg/market-cap-large', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 3);
    return rows.map(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      return cells.map((td, i) => ({
        i,
        text: td.textContent.trim().slice(0, 80),
        class: td.className.slice(0, 60)
      }));
    });
  });

  if (!result.length) {
    // Try other selectors
    const alt = await page.evaluate(() => {
      const items = document.querySelectorAll('[class*="stock"],[class*="company"],[class*="row"]');
      return Array.from(items).slice(0,5).map(el => ({ tag: el.tagName, class: el.className.slice(0,60), text: el.textContent.trim().slice(0,100) }));
    });
    console.log('Alternative selectors:', JSON.stringify(alt, null, 2));
  } else {
    result.forEach((row, ri) => {
      console.log(`\n=== Row ${ri+1} ===`);
      row.forEach(c => console.log(`  [${c.i}] "${c.text}" class: ${c.class}`));
    });
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
