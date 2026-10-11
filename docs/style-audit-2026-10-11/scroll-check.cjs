const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('https://newvers.ai/ru', { waitUntil: 'networkidle' });
  const count = () => page.evaluate(() => document.querySelectorAll('a[href*="/character/"]').length);
  console.log('cards before scroll', await count());
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
    console.log('step', i, 'cards', await count(), 'scrollY', await page.evaluate(() => scrollY), 'height', await page.evaluate(() => document.documentElement.scrollHeight));
  }
  await page.screenshot({ path: path.join(__dirname, 'shots', 'scroll-check-during.png') });
  await page.waitForTimeout(3000);
  console.log('after wait cards', await count(), 'scrollY', await page.evaluate(() => scrollY));
  await page.screenshot({ path: path.join(__dirname, 'shots', 'scroll-check-after.png') });
  await browser.close();
})();
