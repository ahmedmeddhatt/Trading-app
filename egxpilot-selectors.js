const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://egxpilot.com/stocks.html', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    // Get column headers
    const headers = Array.from(document.querySelectorAll('table thead th')).map(th => ({
      text: th.textContent.trim(),
      dataSort: th.getAttribute('data-sort')
    }));

    // Get first 5 data rows
    const rows = Array.from(document.querySelectorAll('table tbody tr')).slice(0, 5).map(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
      return cells;
    });

    return { headers, rows, totalRows: document.querySelectorAll('table tbody tr').length };
  });

  console.log('Total rows:', result.totalRows);
  console.log('\nHeaders:');
  result.headers.forEach((h, i) => console.log(`  [${i}] ${h.dataSort || h.text}`));
  console.log('\nFirst 5 rows:');
  result.rows.forEach((row, i) => console.log(`  Row ${i+1}:`, row.join(' | ')));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
