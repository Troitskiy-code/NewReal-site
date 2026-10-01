import crypto from "crypto";
import { str as crc32str } from "crc-32";
import { debugLog, errorLog, infoLog } from "@/lib/logger";
import { withLocale, type Locale } from "@/lib/i18nConfig";

const SITE_URL = "https://newvers.ai";

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
  cost: number;
  payment_method: "full_payment";
  payment_object: "service";
};

export type RobokassaReceipt = {
  sno: string;
  items: RobokassaReceiptItem[];
};

export type RobokassaCheckout = {
  action: string;
  method: "POST";
  fields: Record<string, string>;
};

const ROBOKASSA_INDEX_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";

/**
 * Фискальный чек (54-ФЗ). Обязательные поля позиции: name, quantity, sum, tax.
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
        cost: unitPrice,
        payment_method: "full_payment",
        payment_object: "service",
      };
    }),
  };
}

export function encodeRobokassaReceipt(receipt: RobokassaReceipt): string {
  return encodeURIComponent(JSON.stringify(receipt));
}

function isUsableEmail(value: string | null | undefined): value is string {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
}

export type RobokassaRecurringOptions = {
  period: "month" | "year";
  amount: number;
};

function nextInvId(): string {
  return String(
    Math.max(1, (Date.now() % 1_000_000_000) * 2 + (Math.floor(Math.random() * 1000) % 2))
  );
}

function buildPaymentSignature(
  outSum: string,
  invId: string,
  shpSuffix: string,
  receiptEncoded: string,
  extras: { successUrl2?: string; successUrl2Method?: string } = {}
): string {
  // Docs additional params (only present ones, in this order):
  // Receipt, StepByStep, ResultUrl2, SuccessUrl2, SuccessUrl2Method, FailUrl2, FailUrl2Method, Token
  // MerchantLogin:OutSum:InvId[:modifiers]:Password#1[:Shp_*]
  const parts = [MERCHANT_ID, outSum, invId];
  if (receiptEncoded) parts.push(receiptEncoded);
  if (extras.successUrl2) {
    parts.push(extras.successUrl2);
    parts.push(extras.successUrl2Method || "GET");
  }
  parts.push(PASSWORD);
  return md5(parts.join(":") + shpSuffix);
}

/**
 * Locale-aware extra Success URL. Official parameter is SuccessUrl2 (not SuccessUrl)
 * and it must be included in SignatureValue after Receipt.
 */
export function buildRobokassaSuccessUrl(
  path: "/pricing" | "/coins",
  locale: Locale,
  query: Record<string, string>
): string {
  const params = new URLSearchParams(query);
  return `${SITE_URL}${withLocale(path, locale)}?${params.toString()}`;
}

export function createRobokassaCheckout(options: {
  userId: string;
  sum: number;
  desc: string;
  extraShp?: ShpParams;
  receipt?: RobokassaReceipt;
  recurring?: RobokassaRecurringOptions;
  successUrl2?: string;
  email?: string | null;
  locale?: Locale;
}): RobokassaCheckout {
  if (!MERCHANT_ID || !PASSWORD) {
    errorLog("Robokassa", "Payment error: merchant or password is not configured");
    throw new Error("Robokassa is not configured");
  }

  const extraShp = options.extraShp ?? {};
  const invId = nextInvId();
  const outSum = Number(options.sum).toFixed(2);
  const isSubscription = extraShp.Shp_subscription === "true";
  const shp: ShpParams = {
    Shp_userId: options.userId,
    ...(isSubscription ? {} : { Shp_vc: String(parseVcFromDesc(options.desc, options.sum)) }),
    ...extraShp,
  };
  const shpSuffix = buildShpSuffix(shp);
  const receiptEncoded = options.receipt ? encodeRobokassaReceipt(options.receipt) : "";
  const successUrl2 = options.successUrl2?.trim() || "";
  const successUrl2Method = successUrl2 ? "GET" : "";
  const signature = buildPaymentSignature(outSum, invId, shpSuffix, receiptEncoded, {
    successUrl2: successUrl2 || undefined,
    successUrl2Method: successUrl2Method || undefined,
  });

  const fields: Record<string, string> = {
    MerchantLogin: MERCHANT_ID,
    OutSum: outSum,
    InvId: invId,
    InvoiceID: invId,
    Description: options.desc,
    SignatureValue: signature,
    Encoding: "utf-8",
    Culture: options.locale === "en" ? "en" : "ru",
  };

  for (const [key, value] of Object.entries(shp)) {
    fields[key] = value;
  }

  if (receiptEncoded) {
    fields.Receipt = receiptEncoded;
  }

  if (successUrl2) {
    fields.SuccessUrl2 = successUrl2;
    fields.SuccessUrl2Method = successUrl2Method;
  }

  if (isUsableEmail(options.email)) {
    fields.Email = options.email.trim();
  }

  if (options.recurring) {
    fields.Recurring = "true";
    fields.RecurringPeriod = options.recurring.period === "year" ? "Yearly" : "Monthly";
    fields.RecurringAmount = Number(options.recurring.amount).toFixed(2);
  }

  if (ROBOKASSA_TEST_MODE) {
    fields.IsTest = "1";
  }

  console.log("[Robokassa] Payment params:", {
    merchantLogin: MERCHANT_ID,
    outSum,
    invId,
    description: options.desc,
    shp: Object.keys(shp).sort().join(","),
    hasReceipt: Boolean(options.receipt),
    hasRecurring: Boolean(options.recurring),
    hasEmail: Boolean(fields.Email),
    isTest: ROBOKASSA_TEST_MODE,
    successUrl2: successUrl2 || null,
    method: "POST",
  });

  if (options.recurring) {
    debugLog(
      "Robokassa",
      `Recurring params: Recurring=true RecurringPeriod=${fields.RecurringPeriod} RecurringAmount=${fields.RecurringAmount} InvId=${invId}`
    );
  }

  infoLog(
    "Robokassa",
    `Payment created: InvId=${invId}, OutSum=${outSum} RUB${receiptEncoded ? ", Receipt included" : ""}${options.recurring ? ", Recurring=true" : ""}, method=POST`
  );

  return {
    action: ROBOKASSA_INDEX_URL,
    method: "POST",
    fields,
  };
}

export async function chargeRobokassaRecurring(options: {
  previousInvoiceId: string;
  sum: number;
  desc: string;
  extraShp?: ShpParams;
  receipt?: RobokassaReceipt;
  email?: string | null;
}): Promise<{ invId: string }> {
  if (!MERCHANT_ID || !PASSWORD) {
    throw new Error("Robokassa is not configured");
  }

  const previousInvoiceId = String(options.previousInvoiceId).trim();
  if (!previousInvoiceId) {
    throw new Error("PreviousInvoiceID is required");
  }

  const invId = nextInvId();
  const outSum = Number(options.sum).toFixed(2);
  const shp = options.extraShp ?? {};
  const shpSuffix = buildShpSuffix(shp);
  const receiptEncoded = options.receipt ? encodeRobokassaReceipt(options.receipt) : "";
  const signature = buildPaymentSignature(outSum, invId, shpSuffix, receiptEncoded);

  const body = new URLSearchParams({
    MerchantLogin: MERCHANT_ID,
    OutSum: outSum,
    InvId: invId,
    InvoiceID: invId,
    PreviousInvoiceID: previousInvoiceId,
    Description: options.desc,
    SignatureValue: signature,
  });

  for (const [key, value] of Object.entries(shp)) {
    body.set(key, value);
  }

  if (receiptEncoded) {
    body.set("Receipt", receiptEncoded);
  }

  if (isUsableEmail(options.email)) {
    body.set("Email", options.email.trim());
  }

  if (ROBOKASSA_TEST_MODE) {
    body.set("IsTest", "1");
  }

  const response = await fetch("https://auth.robokassa.ru/Merchant/Recurring", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const responseText = (await response.text()).trim();
  if (!response.ok) {
    errorLog("Robokassa", `Recurring charge failed: InvId=${invId}, status=${response.status}, body=${responseText}`);
    throw new Error("Robokassa recurring charge failed");
  }

  infoLog("Robokassa", `Recurring charge created: InvId=${invId}, PreviousInvoiceID=${previousInvoiceId}`);
  return { invId };
}

export async function cancelRobokassaRecurring(recurringId: string): Promise<boolean> {
  if (!MERCHANT_ID || !PASSWORD) {
    errorLog("Robokassa", "Recurring cancel skipped: merchant or password is not configured");
    return false;
  }

  const id = String(recurringId).trim();
  if (!id) {
    errorLog("Robokassa", "Recurring cancel skipped: RecurringID is empty");
    return false;
  }

  const body = new URLSearchParams({
    MerchantLogin: MERCHANT_ID,
    RecurringID: id,
    Password1: PASSWORD,
    SignatureValue: md5(`${MERCHANT_ID}:${id}:${PASSWORD}`),
  });

  if (ROBOKASSA_TEST_MODE) {
    body.set("IsTest", "1");
  }

  infoLog("Robokassa", `Recurring cancel request: RecurringID=${id}`);

  try {
    const response = await fetch("https://auth.robokassa.ru/Merchant/Recurring/Cancel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const responseText = (await response.text()).trim();

    if (!response.ok) {
      errorLog(
        "Robokassa",
        `Recurring cancel failed: RecurringID=${id}, status=${response.status}, body=${responseText}`
      );
      return false;
    }

    infoLog("Robokassa", `Recurring cancel succeeded: RecurringID=${id}, body=${responseText}`);
    return true;
  } catch (error) {
    errorLog("Robokassa", `Recurring cancel error: RecurringID=${id}`, error);
    return false;
  }
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
    errorLog("Robokassa", "Webhook error: passwords are not configured");
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
