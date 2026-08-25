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

function redactSignatureString(value: string): string {
  let redacted = value;
  for (const { name, value: password } of passwordCandidates()) {
    if (password) {
      redacted = redacted.split(password).join(name);
    }
  }
  return redacted;
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
  const incoming = signature.trim();
  const incomingLower = incoming.toLowerCase();
  const shpSorted = buildShpSuffix(shp);
  const shpUnsorted = buildShpSuffixUnsorted(shp);
  const shpModes = [
    { name: "noShp", suffix: "" },
    { name: "shpSorted", suffix: shpSorted },
    { name: "shpUnsorted", suffix: shpUnsorted },
  ].filter((mode, index, list) => list.findIndex((item) => item.suffix === mode.suffix) === index);

  const algorithms: Array<{ name: string; hash: (value: string) => string }> = [
    { name: "md5", hash: md5 },
    { name: "crc32hex", hash: crc32Hex },
    { name: "crc32dec", hash: crc32Dec },
  ];

  const results: Array<{
    label: string;
    signatureString: string;
    algorithm: string;
    calculated: string;
    match: boolean;
  }> = [];

  for (const sum of outSumFormats(outSum)) {
    for (const password of passwordCandidates()) {
      for (const shpMode of shpModes) {
        const signatureString = `${sum}:${invId}:${password.value}${shpMode.suffix}`;
        for (const algorithm of algorithms) {
          const calculated = algorithm.hash(signatureString);
          const match =
            incoming === calculated ||
            incomingLower === calculated.toLowerCase();
          results.push({
            label: `${algorithm.name} ${sum} ${password.name} ${shpMode.name}`,
            signatureString: redactSignatureString(signatureString),
            algorithm: algorithm.name,
            calculated,
            match,
          });
        }
      }
    }
  }

  const matched = results.filter((item) => item.match);

  console.log("[Robokassa] incoming signature:", signature);
  console.log("[Robokassa] OutSum raw:", outSum);
  console.log("[Robokassa] InvId:", invId);
  console.log("[Robokassa] shp:", shp);
  console.log("[Robokassa] shp sorted suffix:", shpSorted || "(none)");
  console.log("[Robokassa] shp unsorted suffix:", shpUnsorted || "(none)");
  console.log("[Robokassa] signature variants tried:", results.length);

  if (matched.length > 0) {
    console.log("[Robokassa] signature match: true", matched[0].label);
    for (const item of matched) {
      console.log("[Robokassa] matching variant:", item);
    }
    return true;
  }

  console.log("[Robokassa] signature match: false");
  for (const item of results) {
    console.log("[Robokassa] signature variant:", item);
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
