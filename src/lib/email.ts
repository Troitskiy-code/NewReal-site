import { Resend } from "resend";
import { SITE_URL } from "@/lib/seo";

const LOG = "[Email]";

function getResetPasswordUrl(token: string): string {
  const baseUrl = (process.env.NEXTAUTH_URL || SITE_URL).replace(/\/$/, "");
  return `${baseUrl}/reset-password/${token}`;
}

export async function sendResetPasswordEmail(to: string, token: string): Promise<void> {
  const resetUrl = getResetPasswordUrl(token);
  const text = `Перейдите по ссылке для сброса пароля: ${resetUrl}`;
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

  console.log(`${LOG} Sending password reset email`, { to });

  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Сброс пароля — NewVerse",
    text,
    html: `<p>Перейдите по ссылке для сброса пароля:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действует 1 час. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>`,
  });

  if (error) {
    console.error(`${LOG} Resend API error`, { to, error });
    throw new Error("Failed to send reset email");
  }

  console.log(`${LOG} Password reset email sent`, { to });
}
