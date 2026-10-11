const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('https://newvers.ai/ru', { waitUntil: 'networkidle' });
  const cards = await page.evaluate(() => [...document.querySelectorAll('a[href*="/character/"]')].slice(0, 12).map(a => ({
    href: new URL(a.href).pathname,
    name: a.querySelector('h2')?.innerText.trim(),
    description: a.querySelector('p')?.innerText.trim(),
    image: a.querySelector('img')?.currentSrc,
    messages: a.querySelector('span')?.innerText.trim(),
  })));
  const logo = await page.evaluate(() => { const i = document.querySelector('header img, nav img'); return i && i.currentSrc; });
  fs.writeFileSync(path.join(__dirname, 'cards.json'), JSON.stringify({ logo, cards }, null, 2));
  console.log(JSON.stringify({ logo, cards }, null, 1).slice(0, 4000));
  await browser.close();
})();
