// Read-only public URL probe for exports of Webmaster's unexplained exclusions.
// No login cookies, API/cron calls or full HTML capture.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run seo:audit-urls -- <CSV/JSON/TXT export with full https://newvers.ai URLs>');
const urls = [...new Set(readFileSync(input, 'utf8').match(/https:\/\/newvers\.ai[^\s"<>\\,;]*/g) ?? [])];
if (!urls.length) throw new Error('No full newvers.ai URLs found in the export');
if (urls.length > 2000) throw new Error('Split the export into batches of at most 2000 URLs');
function publicUrl(value) {
  const url = new URL(value.replaceAll('&amp;', '&'));
  if (url.origin !== 'https://newvers.ai' || url.username || url.password) return false;
  const path = url.pathname.replace(/^\/(ru|en)(?=\/|$)/, '') || '/';
  return !/^\/(api|cron|verify-email|reset-password)(\/|$)/.test(path)
    && ![...url.searchParams.keys()].some(key => /secret|token|password|authorization|api.?key/i.test(key));
}
function attribute(tag, key) {
  return tag.match(new RegExp(`${key}=["']([^"']*)["']`, 'i'))?.[1] ?? null;
}
const rows = [];
for (const raw of urls) {
  if (!publicUrl(raw)) { rows.push({ url: '[sensitive or API URL omitted]', skipped: true }); continue; }
  const url = new URL(raw.replaceAll('&amp;', '&')).href;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'NewVerse-SEO-URL-check' } });
    const contentType = response.headers.get('content-type') || '';
    const html = contentType.includes('text/html') ? (await response.text()).slice(0, 2_000_000) : '';
    if (!contentType.includes('text/html')) await response.body?.cancel();
    const tags = html.match(/<(?:meta|link)\b[^>]*>/gi) ?? [];
    const canonical = tags.find(tag => attribute(tag, 'rel') === 'canonical');
    const robots = tags.find(tag => attribute(tag, 'name') === 'robots');
    rows.push({ url, status: response.status, contentType,
      location: response.headers.get('location'), canonical: canonical ? attribute(canonical, 'href') : null,
      robots: robots ? attribute(robots, 'content') : null,
      title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null,
      h1: /<h1\b/i.test(html), html: contentType.includes('text/html'),
    });
  } catch { rows.push({ url, networkError: true }); }
}
mkdirSync('docs', { recursive: true });
const output = resolve(join('docs', `seo-url-probe-${new Date().toISOString().slice(0, 10)}.json`));
writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(),
  scope: 'Read-only public URLs; no conclusion about search demand or exact Webmaster exclusion reason', rows }, null, 2) + '\n');
console.log(`Public URL probe: ${rows.length} records written to ${output}`);
