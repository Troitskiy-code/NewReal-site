import crypto from "crypto";

const MERCHANT_ID = process.env.ROBOKASSA_MERCHANT_ID ?? "";
const PASSWORD = process.env.ROBOKASSA_PASSWORD ?? "";
const PASSWORD2 = process.env.ROBOKASSA_PASSWORD2 ?? PASSWORD;
export const ROBOKASSA_TEST_MODE = process.env.ROBOKASSA_TEST_MODE === "1";

type ShpParams = Record<string, string>;

function buildShpSuffix(params: ShpParams): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return "";
  }

  return `:${entries.map(([key, value]) => `${key}=${value}`).join(":")}`;
}

function md5(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

export function parseVcFromDesc(desc: string, sum: number): number {
  const match = desc.match(/(\d[\d\s]*)\s*VC/i);
  if (match) {
    return Number(match[1].replace(/\s/g, ""));
  }

  return Math.round(sum / 0.3);
}

export function generateRobokassaPaymentUrl(
  userId: string,
  sum: number,
  desc: string
): string {
  if (!MERCHANT_ID || !PASSWORD) {
    throw new Error("Robokassa is not configured");
  }

  const invId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const outSum = Number(sum).toFixed(2);
  const shp: ShpParams = {
    Shp_userId: userId,
    Shp_vc: String(parseVcFromDesc(desc, sum)),
  };

  const signatureString = `${MERCHANT_ID}:${outSum}:${invId}:${PASSWORD}${buildShpSuffix(shp)}`;
  const signature = md5(signatureString);

  console.log("[Robokassa] MerchantLogin:", MERCHANT_ID);
  console.log("[Robokassa] OutSum:", outSum);
  console.log("[Robokassa] InvId:", invId);
  console.log("[Robokassa] signature string:", signatureString);
  console.log("[Robokassa] signature:", signature);

  const shpQuery = Object.entries(shp)
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join("");

  const testParam = ROBOKASSA_TEST_MODE ? "&IsTest=1" : "";
  const url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${MERCHANT_ID}&OutSum=${outSum}&InvId=${invId}&Description=${encodeURIComponent(desc)}&SignatureValue=${signature}${shpQuery}${testParam}`;
  const loggedUrl = url.replace(/SignatureValue=[^&]*/i, "SignatureValue=REDACTED");

  console.log("[Robokassa] payment URL:", loggedUrl);
  console.log("[Robokassa] IsTest:", ROBOKASSA_TEST_MODE ? "1" : "absent");

  return url;
}

export function verifyRobokassaResultSignature(
  outSum: string,
  invId: string,
  signature: string,
  shp: ShpParams
): boolean {
  const signatureString = `${outSum}:${invId}:${PASSWORD2}${buildShpSuffix(shp)}`;
  const calculatedSignature = md5(signatureString);
  const isValid = signature.toLowerCase() === calculatedSignature.toLowerCase();

  console.log("[Robokassa] incoming signature:", signature);
  console.log("[Robokassa] calculated signature:", calculatedSignature);
  console.log("[Robokassa] signature string:", signatureString);
  console.log("[Robokassa] signature match:", isValid);

  return isValid;
}

export function extractShpParams(
  entries: Iterable<[string, FormDataEntryValue | string | null]>
): ShpParams {
  const shp: ShpParams = {};

  for (const [key, value] of entries) {
    if (!/^shp_/i.test(key) || value === null || value === undefined) {
      continue;
    }

    shp[key] = String(value);
  }

  return shp;
}
