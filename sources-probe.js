const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
chromium.use(StealthPlugin());

async function probe(name, url) {
  console.log(`\n=== Probing: ${name} ===`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('response', async (res) => {
    const u = res.url();
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') && !u.includes('google') && !u.includes('font')) {
      try {
        const body = await res.text();
        if (body.length > 100) apiCalls.push({ url: u, body: body.slice(0, 800) });
      } catch (_) {}
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr, [class*="row"], [class*="item"]');
      return {
        rowCount: rows.length,
        title: document.title,
        bodySlice: document.body.innerHTML.slice(0, 1500),
        finalUrl: location.href
      };
    });

    console.log('Title:', info.title);
    console.log('Final URL:', info.finalUrl);
    console.log('Rows/items:', info.rowCount);
    console.log('JSON API calls:', apiCalls.length);
    if (apiCalls.length) apiCalls.slice(0, 3).forEach(c => { console.log('  API:', c.url, '\n  Body:', c.body.slice(0, 200)); });
    fs.writeFileSync(`C:/Users/DELL/${name}.html`, info.bodySlice);
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  await browser.close();
}

(async () => {
  // Try multiple DirectFN URL patterns
  await probe('directfn1', 'https://www.directfn.com/en/homepage');
  await probe('mubasher-api', 'https://www.mubasher.info/api/v2/markets/EGX/quotes?lang=en');
  await probe('investing-egx', 'https://www.investing.com/markets/egypt');
})();
