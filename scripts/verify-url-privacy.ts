/** Pure URL policy checks. Synthetic markers only; no network or production data. */
import assert from "node:assert/strict";
import { analyticsReferrer, analyticsUrl, hasPaymentReturnParams, isPrivatePageUrl, isPaymentQueryKey } from "@/lib/urlPrivacy";

const base = "https://newvers.test/ru/coins";
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
for (const locale of ["ru", "en"]) {
  for (const path of ["coins", "pricing", "chat/synthetic-character"]) {
    const clean = `https://newvers.test/${locale}/${path}`;
    const raw = `${clean}?InvId=42&payment=success&Shp_userId=synthetic-owner&SignatureValue=synthetic-signature&plan=dialog&type=vc&utm_source=direct&yclid=synthetic-click#synthetic-fragment`;
    check(isPrivatePageUrl(new URL(raw)), `${path}: private return ${locale}`);
    check(!isPrivatePageUrl(new URL(clean)), `${path}: clean page remains public ${locale}`);
    const safe = analyticsUrl(raw, base);
    check(safe === `${clean}?utm_source=direct&yclid=synthetic-click`, `${path}: only attribution survives ${locale}`);
    check(analyticsReferrer(raw, base) === safe, `${path}: referrer uses same policy ${locale}`);
  }
  for (const path of ["reset-password", "verify-email", "%72eset-password", "verify-email%2Fsynthetic-token"]) {
    const raw = `https://newvers.test/${locale}/${path}/synthetic-token?utm_source=synthetic-token#synthetic-token`;
    check(isPrivatePageUrl(new URL(raw)), `${path}: private token path`);
    check(!analyticsUrl(raw, base).includes("synthetic-token"), `${path}: token not in analytics`);
  }
}
for (const key of ["INVID", "InvoiceID", "inv_id", "SignatureValue", "SIGNATURE", "crc", "OutSum", "Shp_userId", "Shp_unknown", "Receipt"]) {
  check(hasPaymentReturnParams(new URLSearchParams(`${key}=`)), `${key}: empty marker still private`);
  check(isPaymentQueryKey(key), `${key}: browser cleanup agrees`);
  check(!analyticsUrl(`${base}?${key}=synthetic-value&${key}=synthetic-other`, base).includes("synthetic"), `${key}: repeated values removed`);
}
for (const key of ["token", "access_token", "userId", "email", "code", "state", "password"]) {
  check(isPrivatePageUrl(new URL(`${base}?${key}=synthetic-value`)), `${key}: private query`);
  check(analyticsUrl(`${base}?${key}=synthetic-value`, base) === base, `${key}: excluded from analytics`);
}
check(analyticsUrl(`${base}?plan=dialog`, base) === `${base}?plan=dialog`, "ordinary plan selection preserved");
check(!isPrivatePageUrl(new URL(`${base}?utm_source=direct&yclid=123`)), "ordinary campaign link remains indexable");
check(analyticsUrl(`https://synthetic-name:synthetic-password@newvers.test/ru`, base) === "https://newvers.test/ru", "URL credentials removed");
check(analyticsReferrer("", base) === "", "empty referrer preserved");
check(analyticsReferrer("javascript:synthetic-token", base) === "https://newvers.test/", "unsupported referrer protocol fails closed");
check(analyticsUrl(`${base}?utm_referrer=${encodeURIComponent("https://auth.example.test/pay?token=synthetic-token")}`, base) === `${base}?utm_referrer=https%3A%2F%2Fauth.example.test%2F`, "nested attribution URL retains only origin");
console.log(`SEC-04 URL policy: ${checks} checks passed`);
