const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
chromium.use(StealthPlugin());

async function probe(name, url, waitFor) {
  console.log(`\n=== ${name} ===`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 20000 }).catch(() => console.log('waitFor timed out'));
    }
    await page.waitForTimeout(3000);

    const info = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      const firstRow = rows[1] ? Array.from(rows[1].querySelectorAll('td')).map(td => td.textContent.trim()).join(' | ') : 'none';
      const allClasses = Array.from(new Set(
        Array.from(document.querySelectorAll('*[class]')).map(el => el.className).join(' ').split(/\s+/)
      )).filter(c => c && c.length > 3).slice(0, 30);
      return {
        title: document.title,
        tableCount: document.querySelectorAll('table').length,
        rowCount: rows.length,
        firstRow,
        bodySlice: document.body.innerHTML.slice(0, 3000),
        classes: allClasses
      };
    });

    console.log('Title:', info.title);
    console.log('Tables:', info.tableCount, 'Rows:', info.rowCount);
    console.log('First data row:', info.firstRow);
    console.log('Classes sample:', info.classes.slice(0, 20).join(', '));
    fs.writeFileSync(`C:/Users/DELL/${name}.html`, info.bodySlice);
    console.log(`Saved to C:/Users/DELL/${name}.html`);
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  await browser.close();
}

(async () => {
  await probe('egxpilot-stocks', 'https://egxpilot.com/stocks.html', null);
  await probe('sws-egx', 'https://simplywall.st/stocks/eg/market-cap-large', null);
  await probe('directfn-eg', 'https://www.directfn.com.eg/investor.aspx', null);
})();
