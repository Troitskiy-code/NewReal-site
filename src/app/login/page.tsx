import { isGoogleAuthEnabled } from "@/lib/auth";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return <LoginForm googleAuthEnabled={isGoogleAuthEnabled()} />;
}
