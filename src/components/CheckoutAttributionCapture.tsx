"use client";
import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { usePathname, useSearchParams } from "next/navigation";
import { captureVisitAttribution, setAttributionUser } from "@/lib/checkoutAttributionClient";

export default function CheckoutAttributionCapture() {
  const { data, status } = useSession();
  const pathname = usePathname(), query = useSearchParams();
  useEffect(() => {
    if (status === "loading") return;
    setAttributionUser(data?.user?.id ?? null);
    captureVisitAttribution();
  }, [data?.user?.id, status, pathname, query]);
  return null;
}
