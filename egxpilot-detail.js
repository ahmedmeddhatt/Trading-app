const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://egxpilot.com/stocks.html', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 3);
    return rows.map(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      return cells.map((td, i) => ({
        index: i,
        text: td.textContent.trim(),
        innerHTML: td.innerHTML.trim().slice(0, 300)
      }));
    });
  });

  result.forEach((row, ri) => {
    console.log(`\n=== Row ${ri+1} ===`);
    row.forEach(cell => {
      console.log(`  [${cell.index}] text: "${cell.text}" | html: ${cell.innerHTML}`);
    });
  });

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
