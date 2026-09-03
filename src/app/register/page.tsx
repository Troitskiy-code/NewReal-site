import { Suspense } from "react";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import RegisterForm from "./RegisterForm";

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Регистрация">
          <p className="text-center text-sm text-wd-text-secondary">Загрузка...</p>
        </AuthCard>
      }
    >
      <RegisterForm googleAuthEnabled={isGoogleAuthEnabled()} />
    </Suspense>
  );
}
