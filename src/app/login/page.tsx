import { Suspense } from "react";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { AuthCard } from "@/components/AuthCard";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Вход">
          <p className="text-center text-sm text-wd-text-secondary">Загрузка...</p>
        </AuthCard>
      }
    >
      <LoginForm googleAuthEnabled={isGoogleAuthEnabled()} />
    </Suspense>
  );
}
