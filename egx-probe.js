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
    if (ct.includes('json') || url.includes('api') || url.includes('.ashx') || url.includes('Handler')) {
      try {
        const body = await res.text();
        apiCalls.push({ url, status: res.status(), body: body.slice(0, 600) });
      } catch (_) {}
    }
  });

  await page.goto('https://www.egx.com.eg/en/StocksData.aspx', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(8000);

  console.log('API calls intercepted:', apiCalls.length);
  apiCalls.forEach(c => {
    console.log('\n--- URL:', c.url);
    console.log('Status:', c.status);
    console.log('Body:', c.body);
  });

  // Also dump all script src and xhr patterns from page
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]')).map(s => s.src)
  );
  console.log('\nScripts:', scripts.slice(0, 10));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
