import Script from "next/script";

const DEFAULT_COUNTER_ID = "112171267";

function resolveCounterId() {
  const fromEnv = process.env.NEXT_PUBLIC_YANDEX_METRIKA_ID?.trim();
  if (fromEnv && /^\d+$/.test(fromEnv)) return fromEnv;
  return DEFAULT_COUNTER_ID;
}

const COUNTER_ID = resolveCounterId();

export default function YandexMetrika() {
  if (!COUNTER_ID) return null;

  return (
    <>
      <Script
        id="yandex-metrika"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
            m[i].l=1*new Date();k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
            (window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
            ym(${COUNTER_ID}, "init", {});
          `,
        }}
      />
      <noscript>
        <div>
          <img
            src={`https://mc.yandex.ru/watch/${COUNTER_ID}`}
            style={{ position: "absolute", left: "-9999px" }}
            alt=""
          />
        </div>
      </noscript>
    </>
  );
}
