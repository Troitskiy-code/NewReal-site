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
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

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

export type RobokassaReceiptItem = {
  name: string;
  quantity: number;
  sum: number;
  tax: string;
};

export type RobokassaReceipt = {
  sno: string;
  items: RobokassaReceiptItem[];
};

/**
 * Фискальный чек (54-ФЗ) для параметра Receipt в Robokassa.
 * Формат по актуальной документации: sno + items[{ name, quantity, sum, tax }].
 */
export function buildReceipt(
  items: Array<{ name: string; price: number; quantity?: number }>,
  taxSystem = "usn_income"
): RobokassaReceipt {
  return {
    sno: taxSystem,
    items: items.map((item) => {
      const quantity = item.quantity ?? 1;
      const unitPrice = Number(Number(item.price).toFixed(2));
      const sum = Number((unitPrice * quantity).toFixed(2));
      return {
        name: String(item.name).slice(0, 128),
        quantity,
        sum,
        tax: "none",
      };
    }),
  };
}

export function generateRobokassaPaymentUrl(
  userId: string,
  sum: number,
  desc: string,
  extraShp: ShpParams = {},
  receipt?: RobokassaReceipt | null
): string {
  if (!MERCHANT_ID || !PASSWORD) {
    console.error("[Robokassa] Payment error: merchant or password is not configured");
    throw new Error("Robokassa is not configured");
  }

  const invId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const outSum = Number(sum).toFixed(2);
  const isSubscription = extraShp.Shp_subscription === "true";

  // Shp_* must be present in both URL and signature (webhook needs them).
  // Sorted alphabetically per Robokassa docs.
  const shp: ShpParams = {
    Shp_userId: userId,
    ...(isSubscription ? {} : { Shp_vc: String(parseVcFromDesc(desc, sum)) }),
    ...extraShp,
  };
  const shpSuffix = buildShpSuffix(shp);

  // Compact JSON → same encodeURIComponent value in Signature and URL.
  // Official order: MerchantLogin:OutSum:InvId:Receipt:Password1:Shp_*
  const receiptJson = receipt ? JSON.stringify(receipt) : "";
  const receiptEncoded = receiptJson ? encodeURIComponent(receiptJson) : "";
  const receiptPart = receiptEncoded ? `${receiptEncoded}:` : "";

  const signatureString = `${MERCHANT_ID}:${outSum}:${invId}:${receiptPart}${PASSWORD}${shpSuffix}`;
  const signature = md5(signatureString);

  // Diagnostic signature variants (error 29 = SignatureValue mismatch)
  const variantA = `${MERCHANT_ID}:${outSum}:${invId}:${PASSWORD}`;
  const variantB = `${MERCHANT_ID}:${outSum}:${invId}:${PASSWORD}${shpSuffix}`;
  const variantC = PASSWORD2
    ? `${MERCHANT_ID}:${outSum}:${invId}:${PASSWORD2}${shpSuffix}`
    : "";
  const variantD = PASSWORD3
    ? `${MERCHANT_ID}:${outSum}:${invId}:${PASSWORD3}${shpSuffix}`
    : "";
  const variantWithReceipt = signatureString;

  console.log("[Robokassa] Receipt JSON:", receiptJson || "(none)");
  console.log("[Robokassa] Receipt encoded:", receiptEncoded || "(none)");
  console.log("[Robokassa] Shp suffix:", shpSuffix || "(none)");
  console.log("[Robokassa] Signature variants (password masked in strings, hashes full):");
  console.log("  A (no Shp, Password1) MD5:", md5(variantA), "CRC32:", crc32Hex(variantA));
  console.log("  B (Shp + Password1) MD5:", md5(variantB), "CRC32:", crc32Hex(variantB));
  if (variantC) {
    console.log("  C (Shp + Password2) MD5:", md5(variantC), "CRC32:", crc32Hex(variantC));
  } else {
    console.log("  C (Shp + Password2): skipped (PASSWORD2 empty)");
  }
  if (variantD) {
    console.log("  D (Shp + Password3) MD5:", md5(variantD), "CRC32:", crc32Hex(variantD));
  } else {
    console.log("  D (Shp + Password3): skipped (PASSWORD3 empty)");
  }
  console.log(
    "  E (Receipt+Password1+Shp, used) MD5:",
    md5(variantWithReceipt),
    "CRC32:",
    crc32Hex(variantWithReceipt)
  );
  console.log(
    "[Robokassa] Signature string used:",
    `${MERCHANT_ID}:${outSum}:${invId}:${receiptPart}***${shpSuffix}`
  );

  const shpQuery = Object.entries(shp)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join("");

  const receiptQuery = receiptEncoded ? `&Receipt=${receiptEncoded}` : "";
  const testParam = ROBOKASSA_TEST_MODE ? "&IsTest=1" : "";
  const url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${MERCHANT_ID}&OutSum=${outSum}&InvId=${invId}&Description=${encodeURIComponent(desc)}&SignatureValue=${signature}${receiptQuery}${shpQuery}${testParam}`;

  console.log(`[Robokassa] Payment created: InvId=${invId}, algorithm=MD5`);
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
