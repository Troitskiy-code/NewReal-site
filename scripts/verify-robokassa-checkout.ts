import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function mustContain(source: string, needle: string, label: string) {
  if (!source.includes(needle)) fail(`${label} missing \`${needle}\``);
}

function mustNotContain(source: string, needle: string, label: string) {
  if (source.includes(needle)) fail(`${label} still contains \`${needle}\``);
}

const robokassa = read("src/lib/robokassa.ts");
const paymentCreate = read("src/app/api/payment/create/route.ts");
const subscriptionCreate = read("src/app/api/subscription/create/route.ts");
const coins = read("src/app/coins/page.tsx");
const plans = read("src/components/SubscriptionPlans.tsx");
const metrika = read("src/components/YandexMetrika.tsx");
const redirect = read("src/lib/robokassaRedirect.ts");

mustContain(robokassa, "createRobokassaCheckout", "robokassa.ts");
mustContain(robokassa, "SuccessUrl2", "robokassa.ts");
mustContain(robokassa, "SuccessUrl2Method", "robokassa.ts");
mustContain(robokassa, 'method: "POST"', "robokassa.ts");
mustContain(robokassa, 'payment_object: "service"', "robokassa.ts");
mustContain(robokassa, "fields.Receipt = receiptEncoded", "robokassa.ts");
mustNotContain(robokassa, "SuccessUrl=${", "robokassa.ts");
mustNotContain(robokassa, "&SuccessUrl=", "robokassa.ts");
mustNotContain(robokassa, "generateRobokassaPaymentUrl", "robokassa.ts");

mustContain(paymentCreate, "createRobokassaCheckout", "payment/create");
mustContain(paymentCreate, "successUrl2", "payment/create");
mustContain(paymentCreate, "email: session.user.email", "payment/create");
mustNotContain(paymentCreate, "generateRobokassaPaymentUrl", "payment/create");
mustNotContain(paymentCreate, "{ url }", "payment/create");

mustContain(subscriptionCreate, "createRobokassaCheckout", "subscription/create");
mustContain(subscriptionCreate, "successUrl2", "subscription/create");
mustContain(subscriptionCreate, "email: session.user.email", "subscription/create");
mustNotContain(subscriptionCreate, "generateRobokassaPaymentUrl", "subscription/create");

mustContain(redirect, "form.method", "robokassaRedirect.ts");
mustContain(redirect, 'form.action = checkout.action', "robokassaRedirect.ts");
mustContain(coins, "redirectToRobokassa", "coins/page.tsx");
mustNotContain(coins, "window.location.href = data.url", "coins/page.tsx");
mustContain(plans, "redirectToRobokassa", "SubscriptionPlans.tsx");
mustNotContain(plans, "window.location.href = data.url", "SubscriptionPlans.tsx");

mustContain(metrika, "https://mc.yandex.ru/metrika/tag.js", "YandexMetrika");
mustContain(metrika, "https://mc.yandex.com/metrika/tag.js", "YandexMetrika");
mustContain(metrika, "k.onerror", "YandexMetrika");

const merchant = "demo_shop";
const password = "password1";
const outSum = "499.00";
const invId = "123";
const receiptJson = JSON.stringify({
  sno: "usn_income",
  items: [
    {
      name: "Подписка Dialog на 1 месяц",
      quantity: 1,
      sum: 499,
      tax: "none",
      cost: 499,
      payment_method: "full_payment",
      payment_object: "service",
    },
  ],
});
const receiptEncoded = encodeURIComponent(receiptJson);
const successUrl2 = "https://newvers.ai/en/pricing?payment=success&type=subscription&plan=dialog";
const shpSuffix =
  ":Shp_applyMode=immediate:Shp_period=month:Shp_plan=dialog:Shp_subscription=true:Shp_type=subscription:Shp_userId=user-1";
const signatureString = [merchant, outSum, invId, receiptEncoded, successUrl2, "GET", password].join(":") + shpSuffix;
const signature = crypto.createHash("md5").update(signatureString).digest("hex");
if (signature.length !== 32) fail("md5 signature is not 32 hex chars");
if (signatureString.includes(":SuccessUrl:") || signatureString.includes("&SuccessUrl=")) {
  fail("legacy SuccessUrl leaked into signature string");
}

console.log("Robokassa checkout checks passed");
