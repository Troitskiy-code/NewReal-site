import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { pageIndexingMetadata, PUBLIC_PAGE_PATHS } from "@/lib/seoIndexing";

let checks = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); checks++; }
const origin = "https://newvers.ai";
for (const locale of ["ru", "en"] as const) {
  for (const [page, path] of Object.entries(PUBLIC_PAGE_PATHS)) {
    const metadata = pageIndexingMetadata(page, locale, origin);
    check(metadata.alternates?.canonical === `${origin}/${locale}${path === "/" ? "" : path}`, `${page}: canonical ${locale}`);
    check(metadata.alternates?.languages?.ru && metadata.alternates?.languages?.en, `${page}: both languages`);
    check((metadata.robots as { index: boolean }).index, `${page}: indexable`);
  }
}
for (const page of ["login", "register", "create", "edit", "profile", "referral", "subscription", "notifications", "forgotPassword", "resetPassword", "verifyEmail"]) {
  const metadata = pageIndexingMetadata(page, "ru", origin);
  check((metadata.robots as { index: boolean }).index === false && !metadata.alternates, `${page}: noindex without homepage canonical`);
}
for (const page of ["home", "gallery"]) {
  const base = pageIndexingMetadata(page, "ru", origin);
  const tracked = pageIndexingMetadata(page, "ru", origin, { etext: "ad", ybaip: "ad", utm_source: "direct", sort: "top", page: "1" });
  check(tracked.alternates?.canonical === base.alternates?.canonical, `${page}: advertising/default queries normalized`);
  for (const query of [{ page: "2" }, { sort: "new" }, { sort: "random" }, { q: "hero" }]) {
    const metadata = pageIndexingMetadata(page, "ru", origin, query);
    check(metadata.alternates?.canonical !== base.alternates?.canonical, `${page}: meaningful query preserved`);
    check((metadata.robots as { index: boolean }).index === false, `${page}: variant noindex`);
  }
}
const robots = readFileSync("src/app/robots.txt", "utf8");
check(/Clean-param: etext&ybaip&yclid \/\s/.test(robots), "Clean-param present");
check(!/^Disallow:.*(?:login|chat|_next|gallery)/m.test(robots), "crawlers can read noindex and render public content");

if (process.argv.includes("--http")) {
  // Blank every .env key before Next loads dotenv. No live database or providers.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|API.*KEY|DATABASE_URL|DIRECT_URL/i.test(key)) env[key] = "";
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    if (existsSync(file)) for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = "";
  }
  const port = 3147;
  Object.assign(env, { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/seo_test",
    DIRECT_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/seo_test",
    NEXTAUTH_SECRET: "synthetic_seo_test_only", NEXTAUTH_URL: `http://localhost:${port}`,
    NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
  });
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) throw new Error("Isolated Next server exited before readiness");
      try { ready = (await fetch(`http://127.0.0.1:${port}/robots.txt`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    check(ready, "isolated server ready");
    const html = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "User-Agent": "YandexBot" } });
      check(response.status === 200, `${path}: HTTP 200`);
      return (await response.text()).replaceAll("&amp;", "&");
    };
    for (const path of ["/ru", "/en", "/ru/pricing", "/en/pricing", "/ru/coins", "/ru/gallery"]) {
      const body = await html(path);
      check(body.includes(`rel="canonical" href="${origin}${path}"`), `${path}: emitted canonical`);
      check(body.includes('hrefLang="ru"') && body.includes('hrefLang="en"'), `${path}: emitted hreflang`);
    }
    const tracked = await html("/ru?sort=top&etext=test&ybaip=test");
    check(tracked.includes(`rel="canonical" href="${origin}/ru"`), "HTTP catalog tracking normalized");
    const paginated = await html("/ru/gallery?page=2&etext=test");
    check(paginated.includes(`rel="canonical" href="${origin}/ru/gallery?page=2"`), "HTTP pagination preserved");
    check(/name="robots" content="noindex, follow"/.test(paginated), "HTTP pagination noindex");
    for (const path of ["/ru/login?callbackUrl=%2Fprofile", "/ru/profile", "/ru/chats", "/ru/favorites", "/ru/chat/seo-test-missing"]) {
      const body = await html(path);
      check(/name="robots" content="noindex, follow"/.test(body), `${path}: noindex inherited correctly`);
      check(!/rel="canonical"/.test(body), `${path}: no inherited homepage canonical`);
    }
    const servedRobots = await html("/robots.txt");
    check(servedRobots.includes("Clean-param: etext&ybaip&yclid /"), "HTTP custom robots directive survives Next");
    const sitemap = await html("/sitemap.xml");
    for (const path of ["create", "referral", "profile", "subscription"]) check(!sitemap.includes(`/${path}</loc>`), `sitemap excludes ${path}`);
    check(sitemap.includes(`${origin}/ru/pricing</loc>`), "sitemap retains public pages");
  } finally {
    child.kill();
  }
}
console.log(`SEO phase 1: ${checks} checks passed`);
