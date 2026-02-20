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
    if (ct.includes('json') || url.includes('api') || url.includes('data')) {
      try {
        const body = await res.text();
        apiCalls.push({ url, status: res.status(), body: body.slice(0, 400) });
      } catch (_) {}
    }
  });

  // Test DirectFN with a known EGX symbol
  await page.goto('https://www.directfn.com/en/egx/symbol/EFID/news', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const newsItems = document.querySelectorAll('.news-item');
    const priceEl = document.querySelector('[class*="price"],[class*="Price"]');
    const bodySnippet = document.body.innerHTML.slice(0, 2000);
    return {
      tableCount: tables.length,
      newsCount: newsItems.length,
      price: priceEl ? priceEl.textContent.trim() : null,
      bodySnippet
    };
  });

  console.log('Tables:', info.tableCount, 'News items:', info.newsCount, 'Price:', info.price);
  console.log('API calls:', apiCalls.length);
  apiCalls.forEach(c => console.log('URL:', c.url, '\nBody:', c.body.slice(0, 200)));

  require('fs').writeFileSync('C:/Users/DELL/directfn.html', info.bodySnippet);
  console.log('Saved DirectFN HTML snippet');
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
