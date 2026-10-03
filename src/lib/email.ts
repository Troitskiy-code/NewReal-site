import { Resend } from "resend";
import { SITE_URL } from "@/lib/seo";
import { DEFAULT_LOCALE, type Locale, withLocale } from "@/lib/i18nConfig";
import { translate } from "@/lib/getDictionary";
import { emailDomain } from "@/lib/redactSensitive";
import { errorLog, infoLog } from "@/lib/logger";

function getResetPasswordUrl(token: string, locale: Locale): string {
  const baseUrl = (process.env['NEXTAUTH_URL'] || SITE_URL).replace(/\/$/, "");
  return `${baseUrl}${withLocale(`/reset-password/${token}`, locale)}`;
}

function getVerifyEmailUrl(token: string, locale: Locale): string {
  const baseUrl = (process.env['NEXTAUTH_URL'] || SITE_URL).replace(/\/$/, "");
  return `${baseUrl}${withLocale(`/verify-email/${token}`, locale)}`;
}

function mailMeta(to: string, extra?: Record<string, unknown>) {
  return { domain: emailDomain(to), ...extra };
}

function resolveFrom(): string {
  const fromEnv = process.env.RESEND_FROM_EMAIL?.trim();
  if (!fromEnv) {
    infoLog("Email", "RESEND_FROM_EMAIL is not set; using default sender");
  }
  return fromEnv || "NewVerse <noreply@newvers.ai>";
}

export async function sendResetPasswordEmail(
  to: string,
  token: string,
  locale: Locale = DEFAULT_LOCALE
): Promise<void> {
  const resetUrl = getResetPasswordUrl(token, locale);
  const text = translate(locale, "email.resetText", { url: resetUrl });
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    errorLog("Email", "RESEND_API_KEY is not set; cannot send reset email", mailMeta(to));
    throw new Error("Email is not configured");
  }

  const resend = new Resend(apiKey);
  infoLog("Email", "Sending password reset email", mailMeta(to, { locale }));

  const { error } = await resend.emails.send({
    from: resolveFrom(),
    to,
    subject: translate(locale, "email.resetSubject"),
    text,
    html: `<p>${translate(locale, "email.resetHtmlIntro")}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${translate(locale, "email.resetHtmlFooter")}</p>`,
  });

  if (error) {
    errorLog("Email", "Resend API error", mailMeta(to, { status: "error" }));
    throw new Error("Failed to send reset email");
  }

  infoLog("Email", "Password reset email sent", mailMeta(to, { status: "sent" }));
}

export async function sendVerificationEmail(
  to: string,
  token: string,
  locale: Locale = DEFAULT_LOCALE
): Promise<void> {
  const verifyUrl = getVerifyEmailUrl(token, locale);
  const text = translate(locale, "email.verifyText", { url: verifyUrl });
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    errorLog("Email", "RESEND_API_KEY is not set; cannot send verification email", mailMeta(to));
    throw new Error("Email is not configured");
  }

  const resend = new Resend(apiKey);
  infoLog("Email", "Sending verification email", mailMeta(to, { locale }));

  const { error } = await resend.emails.send({
    from: resolveFrom(),
    to,
    subject: translate(locale, "email.verifySubject"),
    text,
    html: `<p>${translate(locale, "email.verifyHtmlIntro")}</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>${translate(locale, "email.verifyHtmlFooter")}</p>`,
  });

  if (error) {
    errorLog("Email", "Resend API error", mailMeta(to, { status: "error" }));
    throw new Error("Failed to send verification email");
  }

  infoLog("Email", "Verification email sent", mailMeta(to, { status: "sent" }));
}

export async function sendSupportTicketEmail(params: {
  inbox: string;
  topicLabel: string;
  replyTo: string;
  message: string;
  ticketId: string;
  idempotencyKey?: string;
  locale?: Locale;
}): Promise<void> {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    errorLog("Email", "RESEND_API_KEY is not set; cannot send support email", {
      domain: emailDomain(params.replyTo),
      ticketId: params.ticketId,
    });
    throw new Error("Email is not configured");
  }

  const text = translate(locale, "email.supportText", {
    topic: params.topicLabel,
    email: params.replyTo,
    message: params.message,
  });

  const resend = new Resend(apiKey);
  infoLog(
    "Email",
    "Sending support ticket email",
    mailMeta(params.inbox, { ticketId: params.ticketId, status: "sending" })
  );

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const { error } = await Promise.race([
    resend.emails.send({
    from: resolveFrom(),
    to: params.inbox,
    replyTo: params.replyTo,
    subject: translate(locale, "email.supportSubject", { topic: params.topicLabel }),
    text: `${text}\n\nTicket: ${params.ticketId}`,
    }, { idempotencyKey: params.idempotencyKey ?? `support/${params.ticketId}` }),
    new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Support delivery timed out")), 10_000);
    }),
  ]).finally(() => { if (deadline) clearTimeout(deadline); });

  if (error) {
    errorLog("Email", "Resend API error", mailMeta(params.inbox, { ticketId: params.ticketId, status: "error" }));
    throw new Error("Failed to send support email");
  }

  infoLog("Email", "Support ticket email sent", mailMeta(params.inbox, { ticketId: params.ticketId, status: "sent" }));
}
