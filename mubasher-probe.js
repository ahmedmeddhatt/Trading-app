const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') || url.includes('api') || url.includes('stocks') || url.includes('quotes')) {
      try {
        const body = await res.text();
        if (body.length > 50) apiCalls.push({ url, status: res.status(), body: body.slice(0, 500) });
      } catch (_) {}
    }
  });

  await page.goto('https://www.mubasher.info/countries/eg/stocks', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr');
    const firstRow = rows[1] ? rows[1].textContent.trim() : 'no rows';
    return { rowCount: rows.length, sample: firstRow.slice(0, 200) };
  });

  console.log('Rows found:', info.rowCount);
  console.log('Sample row:', info.sample);
  console.log('\nAPI calls:', apiCalls.length);
  apiCalls.slice(0, 5).forEach(c => {
    console.log('\nURL:', c.url);
    console.log('Body:', c.body.slice(0, 300));
  });

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
