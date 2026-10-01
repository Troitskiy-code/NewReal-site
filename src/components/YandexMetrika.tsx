import Script from "next/script";
import { METRIKA_COUNTER_ID } from "@/lib/metrika";

const METRIKA_TAG_PRIMARY = "https://mc.yandex.com/metrika/tag.js";
const METRIKA_TAG_FALLBACK = "https://mc.yandex.ru/metrika/tag.js";

export default function YandexMetrika() {
  if (!METRIKA_COUNTER_ID) return null;

  return (
    <>
      <Script
        id="yandex-metrika"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function(m,e,t,r,i,k,a){
              m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
              m[i].l=1*new Date();
              for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
              k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r;
              k.onerror=function(){k.onerror=null;k.src="${METRIKA_TAG_FALLBACK}";};
              a.parentNode.insertBefore(k,a)
            })
            (window, document, "script", "${METRIKA_TAG_PRIMARY}", "ym");
            ym(${METRIKA_COUNTER_ID}, "init", {});
          `,
        }}
      />
      <noscript>
        <div>
          <img
            src={`https://mc.yandex.com/watch/${METRIKA_COUNTER_ID}`}
            style={{ position: "absolute", left: "-9999px" }}
            alt=""
          />
        </div>
      </noscript>
    </>
  );
}
