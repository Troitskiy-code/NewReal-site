import { Suspense } from "react";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import LoginForm from "./LoginForm";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";

export default async function LoginPage() {
  const locale = await getRequestLocale();

  return (
    <Suspense
      fallback={
        <AuthCard title={translate(locale, "auth.loginTitle")}>
          <p className="text-center text-sm text-wd-text-secondary">{translate(locale, "auth.loading")}</p>
        </AuthCard>
      }
    >
      <LoginForm googleAuthEnabled={isGoogleAuthEnabled()} />
    </Suspense>
  );
}
