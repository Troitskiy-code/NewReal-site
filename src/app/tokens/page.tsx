import { redirect } from "next/navigation";

export default function TokensRedirectPage() {
  redirect("/coins");
}
