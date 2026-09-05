import { Suspense } from "react";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import RegisterForm from "./RegisterForm";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";

export default async function RegisterPage() {
  const locale = await getRequestLocale();

  return (
    <Suspense
      fallback={
        <AuthCard title={translate(locale, "auth.registerTitle")}>
          <p className="text-center text-sm text-wd-text-secondary">{translate(locale, "auth.loading")}</p>
        </AuthCard>
      }
    >
      <RegisterForm googleAuthEnabled={isGoogleAuthEnabled()} />
    </Suspense>
  );
}
