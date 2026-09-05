import { Resend } from "resend";
import { SITE_URL } from "@/lib/seo";
import { DEFAULT_LOCALE, type Locale, withLocale } from "@/lib/i18nConfig";
import { translate } from "@/lib/getDictionary";

const LOG = "[Email]";

function getResetPasswordUrl(token: string, locale: Locale): string {
  const baseUrl = (process.env.NEXTAUTH_URL || SITE_URL).replace(/\/$/, "");
  return `${baseUrl}${withLocale(`/reset-password/${token}`, locale)}`;
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
    console.error(`${LOG} RESEND_API_KEY is not set; cannot send reset email`, { to });
    throw new Error("Email is not configured");
  }

  const fromEnv = process.env.RESEND_FROM_EMAIL?.trim();
  if (!fromEnv) {
    console.warn(
      `${LOG} RESEND_FROM_EMAIL is not set; using default sender NewVerse <noreply@newvers.ai>`
    );
  }
  const from = fromEnv || "NewVerse <noreply@newvers.ai>";
  const resend = new Resend(apiKey);

  console.log(`${LOG} Sending password reset email`, { to, locale });

  const { error } = await resend.emails.send({
    from,
    to,
    subject: translate(locale, "email.resetSubject"),
    text,
    html: `<p>${translate(locale, "email.resetHtmlIntro")}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${translate(locale, "email.resetHtmlFooter")}</p>`,
  });

  if (error) {
    console.error(`${LOG} Resend API error`, { to, error });
    throw new Error("Failed to send reset email");
  }

  console.log(`${LOG} Password reset email sent`, { to });
}
