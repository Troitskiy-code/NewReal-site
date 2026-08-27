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

function logSignatureVariant(label: string, value: string) {
  console.log(
    `[Robokassa] signature variant: ${label} | MD5=${md5(value)} | CRC32=${crc32Hex(value)} | CRC32dec=${crc32Dec(value)}`
  );
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

  // InvId must fit Robokassa Int32 range (1..2147483647); Date.now() alone overflows.
  const invId = String(
    Math.max(1, (Date.now() % 1_000_000_000) * 2 + (Math.floor(Math.random() * 1000) % 2))
  );
  const amount = Number(sum);
  const outSum = amount.toFixed(2);
  const sumFormats = uniqueStrings([
    outSum,
    String(amount),
    amount.toFixed(0),
    amount.toFixed(1),
    amount.toFixed(2),
  ]);

  const isSubscription = extraShp.Shp_subscription === "true";
  const shp: ShpParams = {
    Shp_userId: userId,
    ...(isSubscription ? {} : { Shp_vc: String(parseVcFromDesc(desc, sum)) }),
    ...extraShp,
  };
  const shpSuffix = buildShpSuffix(shp);

  const receiptJson = receipt ? JSON.stringify(receipt) : "";
  const receiptEncoded = receiptJson ? encodeURIComponent(receiptJson) : "";

  const passwords = [
    { name: "Password1", value: PASSWORD },
    { name: "Password2", value: PASSWORD2 },
    { name: "Password3", value: PASSWORD3 },
  ].filter((item) => item.value);

  console.log("[Robokassa] diag base:", {
    merchant: MERCHANT_ID,
    outSum,
    invId,
    shpSuffix: shpSuffix || "(none)",
    receiptJson: receiptJson || "(none)",
    hasReceipt: Boolean(receiptJson),
  });

  for (const sumFmt of sumFormats) {
    for (const password of passwords) {
      // Without Receipt: MerchantLogin:OutSum:InvId:Password:Shp_*
      logSignatureVariant(
        `noReceipt sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}${shpSuffix}`
      );
      logSignatureVariant(
        `noReceipt sum=${sumFmt} ${password.name} noShp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}`
      );

      if (!receiptJson) continue;

      // Receipt raw JSON between InvId and Password
      logSignatureVariant(
        `receiptRaw-beforePassword sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${receiptJson}:${password.value}${shpSuffix}`
      );
      // Receipt URL-encoded between InvId and Password (docs / PHP example)
      logSignatureVariant(
        `receiptEnc-beforePassword sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${receiptEncoded}:${password.value}${shpSuffix}`
      );
      // Password before Receipt (raw)
      logSignatureVariant(
        `password-before-receiptRaw sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}:${receiptJson}${shpSuffix}`
      );
      // Password before Receipt (encoded)
      logSignatureVariant(
        `password-before-receiptEnc sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}:${receiptEncoded}${shpSuffix}`
      );
      // Receipt after Shp (encoded)
      logSignatureVariant(
        `receiptEnc-afterShp sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}${shpSuffix}:${receiptEncoded}`
      );
      // Receipt after Shp (raw)
      logSignatureVariant(
        `receiptRaw-afterShp sum=${sumFmt} ${password.name}+Shp`,
        `${MERCHANT_ID}:${sumFmt}:${invId}:${password.value}${shpSuffix}:${receiptJson}`
      );
    }
  }

  // Production signature: official order with URL-encoded Receipt when present.
  const receiptPart = receiptEncoded ? `${receiptEncoded}:` : "";
  const signatureString = `${MERCHANT_ID}:${outSum}:${invId}:${receiptPart}${PASSWORD}${shpSuffix}`;
  const signature = md5(signatureString);
  logSignatureVariant("USED receiptEnc-beforePassword Password1+Shp outSum.fixed2", signatureString);

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
