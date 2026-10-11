const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const base = 'https://newvers.ai';
const out = __dirname;
const shots = path.join(out, 'shots');
fs.mkdirSync(shots, { recursive: true });

const routes = ['/ru', '/ru/coins', '/ru/create', '/ru/login', '/ru/register', '/ru/rules', '/ru/subscription'];
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

function collect() {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0.9) return c; } return parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0 }; };
  const fonts = {}, sizes = {}, colors = {}, bgs = {}, radii = {}, weights = {};
  const lowContrast = [], smallTargets = [];
  const all = [...document.querySelectorAll('body *')];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue;
    const ownText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') bgs[s.backgroundColor] = (bgs[s.backgroundColor] || 0) + 1;
    if (s.borderRadius !== '0px') radii[s.borderRadius] = (radii[s.borderRadius] || 0) + 1;
    if (ownText) {
      const fam = s.fontFamily.split(',')[0].trim();
      fonts[fam] = (fonts[fam] || 0) + 1;
      sizes[s.fontSize] = (sizes[s.fontSize] || 0) + 1;
      weights[s.fontWeight] = (weights[s.fontWeight] || 0) + 1;
      colors[s.color] = (colors[s.color] || 0) + 1;
      const fg = parse(s.color), bg = bgOf(el);
      if (fg && bg) {
        const a = fg.a;
        const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
        const L1 = lum(mix), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
        if (ratio < (large ? 3 : 4.5)) lowContrast.push({ text: ownText.slice(0, 60), ratio: +ratio.toFixed(2), color: s.color, size: s.fontSize });
      }
    }
    if (el.matches('a,button,[role=button],input,select,textarea') && (r.width < 40 || r.height < 40) && r.top < document.documentElement.scrollHeight)
      smallTargets.push({ tag: el.tagName, text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
  }
  const sort = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({ tag: h.tagName, text: h.innerText.trim().slice(0, 80), size: getComputedStyle(h).fontSize, weight: getComputedStyle(h).fontWeight }));
  const buttons = [...document.querySelectorAll('button,a[class*=btn],a[class*=button],a[class*=rounded]')].slice(0, 400).map(b => { const s = getComputedStyle(b); return `${s.backgroundColor}|${s.backgroundImage.slice(0, 50)}|${s.borderRadius}|${s.fontSize}|${s.paddingTop}`; });
  const buttonStyles = {}; buttons.forEach(b => buttonStyles[b] = (buttonStyles[b] || 0) + 1);
  return {
    title: document.title,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyFont: getComputedStyle(document.body).fontFamily,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    pageHeight: document.documentElement.scrollHeight,
    fonts: sort(fonts), sizes: sort(sizes), weights: sort(weights), textColors: sort(colors).slice(0, 25), bgColors: sort(bgs).slice(0, 25), radii: sort(radii),
    headings, buttonStyles: sort(buttonStyles).slice(0, 20),
    lowContrast: lowContrast.slice(0, 40), lowContrastCount: lowContrast.length,
    smallTargets: smallTargets.slice(0, 40), smallTargetCount: smallTargets.length,
    brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src).slice(0, 10),
    imagesWithoutAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
  };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch({ channel: 'msedge' }));
  const result = {};
  let characterRoute = null, chatRoute = null;
  for (const [vp, size] of Object.entries(viewports)) {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: vp === 'mobile' ? 2 : 1, locale: 'ru-RU', isMobile: vp === 'mobile', hasTouch: vp === 'mobile' });
    const page = await context.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    const list = [...routes];
    if (characterRoute) list.push(characterRoute);
    if (chatRoute) list.push(chatRoute);
    for (let i = 0; i < list.length; i++) {
      const route = list[i];
      const started = Date.now();
      const res = await page.goto(base + route, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => ({ status: () => 'ERR ' + e.message.slice(0, 80) }));
      await page.waitForTimeout(1500);
      if (route === '/ru' && !characterRoute) {
        characterRoute = await page.evaluate(() => { const a = document.querySelector('a[href*="/character/"]'); return a && new URL(a.href).pathname; });
        chatRoute = await page.evaluate(() => { const a = document.querySelector('a[href*="/chat/"]'); return a && new URL(a.href).pathname; });
        if (characterRoute) list.push(characterRoute);
        if (chatRoute) list.push(chatRoute);
      }
      const name = `${vp}-${route.replace(/^\//, '').replace(/[\/?=&]/g, '_') || 'root'}`;
      await page.screenshot({ path: path.join(shots, name + '-fold.png') });
      await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 700) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } scrollTo(0, 0); });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(shots, name + '-full.png'), fullPage: true });
      const data = await page.evaluate(collect);
      result[name] = { route, url: page.url(), status: res.status(), loadMs: Date.now() - started, ...data };
      console.log(name, res.status(), page.url(), 'h=' + data.pageHeight, 'lowContrast=' + data.lowContrastCount, 'small=' + data.smallTargetCount, 'overflow=' + data.overflowX);
    }
    result[`${vp}-consoleErrors`] = [...new Set(errors)].slice(0, 30);
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(result, null, 2));
})();
