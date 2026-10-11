const { chromium } = require('playwright');
const path = require('path');
const { pathToFileURL } = require('url');

const file = pathToFileURL(path.join(__dirname, 'mockups.html')).href;
const out = path.join(__dirname, 'mockups');

const shots = [
  { name: 'palette', query: 'only=palette&theme=a', viewport: { width: 1480, height: 900 }, full: true },
  { name: 'cards-a', query: 'only=cards&theme=a', viewport: { width: 1480, height: 900 }, full: true },
  { name: 'home-desktop-a', query: 'only=home&theme=a', viewport: { width: 1480, height: 1000 }, full: true },
  { name: 'home-desktop-b', query: 'only=home&theme=b', viewport: { width: 1480, height: 1000 }, full: false },
  { name: 'home-mobile-a', query: 'only=home&theme=a', viewport: { width: 390, height: 844 }, mobile: true, full: false },
  { name: 'home-mobile-a-full', query: 'only=home&theme=a', viewport: { width: 390, height: 844 }, mobile: true, full: true },
];

(async () => {
  require('fs').mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
  for (const s of shots) {
    const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.mobile ? 2 : 1, isMobile: !!s.mobile, hasTouch: !!s.mobile });
    const page = await context.newPage();
    await page.goto(`${file}?${s.query}`, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => {
      const ready = Promise.all([document.fonts.ready, ...[...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))]);
      await Promise.race([ready, new Promise(r => setTimeout(r, 15000))]);
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, s.name + '.png'), fullPage: s.full });
    const broken = await page.evaluate(() => [...document.images].filter(i => i.naturalWidth === 0).length);
    console.log(s.name, 'brokenImages=' + broken);
    await context.close();
  }
  await browser.close();
})();
