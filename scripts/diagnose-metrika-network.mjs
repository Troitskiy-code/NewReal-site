// Read-only connectivity probe. Reads tag.js as a resource, never initializes
// any counter or sends a goal. Browser runs without user extensions/profile.
import { chromium } from 'playwright';
const urls = ['https://mc.yandex.com/metrika/tag.js', 'https://mc.yandex.ru/metrika/tag.js'];
const results = [];
for (const url of ['https://example.com', 'https://yandex.ru']) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    results.push({ transport: 'control', url, status: response.status }); await response.body?.cancel();
  } catch (error) { results.push({ transport: 'control', url, error: error.cause?.code ?? error.name }); }
}
for (const url of urls) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    results.push({ transport: 'node', url, status: response.status, bytes: (await response.arrayBuffer()).byteLength });
  } catch (error) { results.push({ transport: 'node', url, error: error.cause?.code ?? error.name }); }
}
const browser = await chromium.launch({ headless: true, channel: process.env.METRIKA_TEST_BROWSER_CHANNEL });
try {
  const context = await browser.newContext();
  for (const url of urls) {
    const page = await context.newPage();
    // A top-level JS document is displayed/read, not inserted as executable script.
    try {
      const response = await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      results.push({ transport: 'browser', url, status: response?.status(), bytes: (await response.body()).byteLength });
    } catch (error) { results.push({ transport: 'browser', url, error: error.message.split('\n')[0] }); }
    await page.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), initializedCounter: false, sentGoals: false, results }, null, 2));
