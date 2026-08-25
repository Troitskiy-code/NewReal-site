import crypto from "crypto";
import { str as crc32str } from "crc-32";

const MERCHANT_ID = process.env.ROBOKASSA_MERCHANT_ID ?? "";
const PASSWORD = process.env.ROBOKASSA_PASSWORD ?? "";
const PASSWORD2 = process.env.ROBOKASSA_PASSWORD2 ?? PASSWORD;
const PASSWORD3 = process.env.ROBOKASSA_PASSWORD3 ?? "";
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

function buildShpSuffixUnsorted(params: ShpParams): string {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== ""
  );

  if (entries.length === 0) {
    return "";
  }

  return `:${entries.map(([key, value]) => `${key}=${value}`).join(":")}`;
}

function md5(value: string): string {
  return crypto.createHash("md5").update(value).digest("hex");
}

function crc32Hex(value: string): string {
  return (crc32str(value) >>> 0).toString(16).padStart(8, "0");
}

function crc32Dec(value: string): string {
  return String(crc32str(value) >>> 0);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function outSumFormats(outSum: string): string[] {
  const normalized = outSum.replace(",", ".");
  const amount = Number(normalized);
  const formats = [outSum, normalized, "10", "10.0", "10.00", "10.000000"];

  if (Number.isFinite(amount)) {
    formats.push(String(amount), amount.toFixed(0), amount.toFixed(1), amount.toFixed(2), amount.toFixed(6));
  }

  return uniqueStrings(formats);
}

function passwordCandidates() {
  const passwords = [
    { name: "Password1", value: PASSWORD },
    { name: "Password2", value: PASSWORD2 },
  ];

  if (PASSWORD3) {
    passwords.push({ name: "Password3", value: PASSWORD3 });
  }

  return passwords.filter((item) => item.value);
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
    console.error("[Robokassa] Payment error: merchant or password is not configured");
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

  const shpQuery = Object.entries(shp)
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join("");

  const testParam = ROBOKASSA_TEST_MODE ? "&IsTest=1" : "";
  const url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${MERCHANT_ID}&OutSum=${outSum}&InvId=${invId}&Description=${encodeURIComponent(desc)}&SignatureValue=${signature}${shpQuery}${testParam}`;

  console.log(`[Robokassa] Payment created: InvId=${invId}`);
  return url;
}

export function verifyRobokassaResultSignature(
  outSum: string,
  invId: string,
  signature: string,
  shp: ShpParams
): boolean {
  const incoming = signature.trim();
  const incomingLower = incoming.toLowerCase();
  const passwords = passwordCandidates();

  if (!passwords.length) {
    console.error("[Robokassa] Webhook error: passwords are not configured");
    return false;
  }

  const shpSuffixes = [...new Set(["", buildShpSuffix(shp), buildShpSuffixUnsorted(shp)])];
  const hashFns = [md5, crc32Hex, crc32Dec];

  const matches = (value: string) =>
    hashFns.some((hash) => {
      const calculated = hash(value);
      return incoming === calculated || incomingLower === calculated.toLowerCase();
    });

  for (const sum of outSumFormats(outSum)) {
    for (const password of passwords) {
      for (const suffix of shpSuffixes) {
        if (matches(`${sum}:${invId}:${password.value}${suffix}`)) {
          return true;
        }
      }
    }
  }

  return false;
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
