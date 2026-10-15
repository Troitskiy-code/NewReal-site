import { Suspense } from "react";
import { isGoogleAuthEnabled } from "@/lib/googleAuth";
import { AuthCard } from "@/components/AuthCard";
import RegisterForm from "./RegisterForm";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { isTelegramContext } from "@/lib/telegram/context";

export default async function RegisterPage() {
  const locale = await getRequestLocale();
  // Google OAuth does not work in Telegram's built-in browser.
  const googleAuthEnabled = isGoogleAuthEnabled() && !(await isTelegramContext());

  return (
    <Suspense
      fallback={
        <AuthCard title={translate(locale, "auth.registerTitle")}>
          <p className="text-center text-sm text-wd-text-secondary">{translate(locale, "auth.loading")}</p>
        </AuthCard>
      }
    >
      <RegisterForm googleAuthEnabled={googleAuthEnabled} />
    </Suspense>
  );
}
