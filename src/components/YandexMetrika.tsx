"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { METRIKA_COUNTER_ID } from "@/lib/metrika";
import { METRIKA_TAG_FALLBACK, METRIKA_TAG_PRIMARY, startMetrikaLoader, syncMetrikaPage } from "@/lib/metrikaLoader";

export { METRIKA_TAG_PRIMARY, METRIKA_TAG_FALLBACK };

export default function YandexMetrika() {
  const pathname = usePathname();
  useEffect(() => {
    startMetrikaLoader(METRIKA_COUNTER_ID);
  }, []);
  useEffect(() => { syncMetrikaPage(); }, [pathname]);

  if (!METRIKA_COUNTER_ID) return null;

  return (
    <noscript>
      <div>
        {/* Tracking pixel from Yandex; next/image is not applicable here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://mc.yandex.com/watch/${METRIKA_COUNTER_ID}`}
          referrerPolicy="no-referrer"
          style={{ position: "absolute", left: "-9999px" }}
          alt=""
        />
      </div>
    </noscript>
  );
}
