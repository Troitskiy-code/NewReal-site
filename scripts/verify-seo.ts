import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const result = spawnSync(process.execPath, ["scripts/verify-seo-runtime.mjs"], { stdio: "inherit", windowsHide: true });
  check(result.status === 0, "isolated SEO HTTP/DB/browser suite");
}
console.log(`SEO phase 1: ${checks} checks passed`);
