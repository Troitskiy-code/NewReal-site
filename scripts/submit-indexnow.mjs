// Public sitemap only. No database, authentication cookies, private URLs or environment secrets.
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../src/lib/indexNowConfig.json", import.meta.url), "utf8"));
const origin = `https://${config.host}`;
const keyLocation = `${origin}/${config.key}.txt`;
const submit = process.argv.includes("--submit");

const verification = await fetch(keyLocation, { redirect: "error", signal: AbortSignal.timeout(20000) });
if (!verification.ok || (await verification.text()).trim() !== config.key) throw new Error("IndexNow key is not live on the site yet");
const response = await fetch(`${origin}/sitemap.xml`, { redirect: "error", signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Sitemap returned HTTP ${response.status}`);
const xml = await response.text();
if (!xml.includes("<urlset")) throw new Error("Expected a sitemap URL set");
const urls = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replaceAll("&amp;", "&")))];
if (!urls.length || urls.some((value) => {
  const url = new URL(value);
  return url.origin !== origin || url.search || url.hash || !/^\/(ru|en)(\/|$)/.test(url.pathname) || /\/(api|chat|profile|edit)(\/|$)/.test(url.pathname);
})) throw new Error("Sitemap contains unexpected URLs; nothing was submitted");

if (!submit) console.log(JSON.stringify({ dryRun: true, urls: urls.length, host: config.host }));
else for (let offset = 0; offset < urls.length; offset += 10000) {
  const urlList = urls.slice(offset, offset + 10000);
  const sent = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...config, keyLocation, urlList }), redirect: "error", signal: AbortSignal.timeout(30000),
  });
  if (!sent.ok) throw new Error(`IndexNow returned HTTP ${sent.status}`);
  console.log(JSON.stringify({ submitted: urlList.length, status: sent.status, host: config.host }));
}
