"use client";

import { resolveLocale } from "@/lib/i18nConfig";

import { localizedCharacterText } from "@/lib/characterLocalization";


import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { FaCheck, FaChevronLeft } from "react-icons/fa";
import { reachGoal, METRIKA_GOALS } from "@/lib/metrika";
import { withLocale } from "@/lib/i18nConfig";
import { characterTagLabel } from "@/lib/characterTags";
import { getLocalizedCardDescription, stripLeadingName } from "@/lib/characterFields";
import {
  MAX_ONBOARDING_INTERESTS, ONBOARDING_COMPLETED_MAX_AGE, ONBOARDING_COOKIE, ONBOARDING_INTERESTS, ONBOARDING_SKIPPED_MAX_AGE,
  hasOnboardingSignals, onboardingInterestTags, parseOnboardingStyle, serializeOnboardingPrefs,
  type ArtStyle, type OnboardingGender, type OnboardingInterest, type OnboardingPrefs, type OnboardingStatus, type OnboardingStyle,
} from "@/lib/onboarding";
import type { OnboardingPicks } from "@/lib/onboardingPicks";

export type OnboardingSource = "organic" | "reopen" | "hero";
type Step = 1 | 2 | 3;
type Pick = OnboardingPicks["characters"][number];
type Results = { state: "loading" } | { state: "error" } | { state: "ready"; characters: Pick[] };

type EarlyTapWindow = Window & { __nvOnboardingTap?: string | null; __nvOnboardingReady?: boolean };
/**
 * The picker arrives in the HTML seconds before React can handle a tap (9–11 s on slow 4G). This inline
 * listener remembers a style tapped in that window and marks it; the component replays it after hydration.
 */
const EARLY_TAP_SCRIPT = `(function(){var w=window;if(w.__nvOnboardingTap!==undefined)return;w.__nvOnboardingTap=null;
document.addEventListener("click",function(e){if(w.__nvOnboardingReady)return;var b=e.target&&e.target.closest&&e.target.closest("[data-onboarding-style]");
if(!b)return;w.__nvOnboardingTap=b.getAttribute("data-onboarding-style");b.setAttribute("data-early-tap","")},true)})();`;

export function writeOnboardingCookie(prefs: OnboardingPrefs) {
  const maxAge = prefs.status === "completed" ? ONBOARDING_COMPLETED_MAX_AGE : ONBOARDING_SKIPPED_MAX_AGE;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${ONBOARDING_COOKIE}=${serializeOnboardingPrefs(prefs)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function picksUrl(style: OnboardingStyle | null, interests: OnboardingInterest[], gender: OnboardingGender | null, extra: Record<string, string>) {
  const params = new URLSearchParams({ ...(style ? { style } : {}), interests: interests.join(","), ...(gender ? { gender } : {}), ...extra });
  return `/api/onboarding/picks?${params}`;
}

/** *Action* spans (also **action** and ***action***) are shown in italics; everything stays a text node, no markup is injected. */
function Greeting({ text }: { text: string }) {
  return <>{text.split(/(\*{1,3}[^*]+\*{1,3})/g).map((part, i) => /^\*+[^*]+\*+$/.test(part)
    ? <em key={i} className="text-zinc-500">{part.replace(/^\*+|\*+$/g, "")}</em> : <span key={i}>{part}</span>)}</>;
}

function Tick({ small = false }: { small?: boolean }) {
  return <span aria-hidden className={`absolute right-2.5 top-2.5 z-10 grid place-items-center rounded-full bg-wd-primary text-white ${small ? "h-6 w-6" : "h-7 w-7"}`}>
    <FaCheck size={small ? 11 : 13} />
  </span>;
}

export default function FirstStepOnboarding({ source, initialPrefs, onClose }: {
  source: OnboardingSource; initialPrefs: OnboardingPrefs | null;
  /** Receives the saved answers; the page reloads "for you" when it is already on it. */
  onClose: (prefs: OnboardingPrefs) => void;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);
  const [step, setStep] = useState<Step>(1);
  const [style, setStyle] = useState<OnboardingStyle | null>(initialPrefs?.style ?? null);
  const [interests, setInterests] = useState<OnboardingInterest[]>(initialPrefs?.interests ?? []);
  const [gender, setGender] = useState<OnboardingGender | null>(initialPrefs?.gender ?? null);
  const [count, setCount] = useState<number | null>(null);
  const [limitHint, setLimitHint] = useState(false);
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<Results>({ state: "loading" });
  const [leaving, setLeaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<Step>(1);
  useEffect(() => { stepRef.current = step; }, [step]);

  useEffect(() => {
    reachGoal(METRIKA_GOALS.onboardingShown, { source });
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [source]);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [step, results.state]);

  const finish = useCallback((status: OnboardingStatus, target: "close" | "catalog" | { chat: string }) => {
    const prefs: OnboardingPrefs = { status, style, interests, gender };
    writeOnboardingCookie(prefs);
    setLeaving(true);
    if (typeof target === "object") {
      router.push(withLocale(`/chat/${target.chat}`, locale));
      return;
    }
    // "For you" reads the cookie on the server, so the catalog reorders by these answers.
    if (hasOnboardingSignals(prefs)) router.push(`${withLocale("/", locale)}?sort=for-you`);
    onClose(prefs);
  }, [style, interests, gender, router, locale, onClose]);

  const skip = useCallback(() => {
    reachGoal(METRIKA_GOALS.onboardingSkip, { step: stepRef.current });
    finish("skipped", "close");
  }, [finish]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") skip(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  // Live counter under the interests: a cheap count-only request, latest answer wins.
  useEffect(() => {
    if (step !== 2 || !interests.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(picksUrl(style, interests, gender, { count: "1" }), { signal: controller.signal })
        .then(response => response.ok ? response.json() : null)
        .then((data: { total?: number } | null) => setCount(typeof data?.total === "number" ? data.total : null))
        .catch(() => { /* the counter is a hint; the button still works */ });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [step, style, interests, gender]);

  useEffect(() => {
    if (step !== 3) return;
    const controller = new AbortController();
    fetch(picksUrl(style, interests, gender, { page: String(page) }), { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.json() as Promise<OnboardingPicks>; })
      .then(data => {
        setResults({ state: "ready", characters: data.characters });
        reachGoal(METRIKA_GOALS.onboardingResults, { count: data.characters.length, fallback: data.characters.some(item => item.fallback), page });
      })
      .catch(error => { if (!controller.signal.aborted) { console.warn("[Onboarding] picks failed", error); setResults({ state: "error" }); } });
    return () => controller.abort();
  }, [step, style, interests, gender, page, attempt]);

  const chooseStyle = useCallback((value: OnboardingStyle) => {
    setStyle(value);
    reachGoal(METRIKA_GOALS.onboardingStyle, { style: value });
    window.setTimeout(() => setStep(2), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
  }, []);
  useEffect(() => {
    const w = window as EarlyTapWindow;
    w.__nvOnboardingReady = true;
    const early = parseOnboardingStyle(w.__nvOnboardingTap);
    w.__nvOnboardingTap = null;
    if (!early) return;
    const timer = window.setTimeout(() => chooseStyle(early), 0);
    return () => window.clearTimeout(timer);
  }, [chooseStyle]);
  const toggleInterest = (id: OnboardingInterest) => {
    setLimitHint(false);
    if (interests.includes(id)) setInterests(interests.filter(item => item !== id));
    else if (interests.length < MAX_ONBOARDING_INTERESTS) setInterests([...interests, id]);
    else setLimitHint(true);
  };
  const showResults = () => {
    reachGoal(METRIKA_GOALS.onboardingGenres, { interests: interests.join(","), gender: gender ?? "any", count: count ?? -1 });
    setPage(0);
    setResults({ state: "loading" });
    setStep(3);
  };
  const back = () => { if (step > 1) setStep((step - 1) as Step); };

  const styleKey: ArtStyle | "any" = style ?? "any";
  const tileStyle = (index: number): ArtStyle => style === "anime" || style === "realistic" ? style : index % 2 ? "realistic" : "anime";
  const interestLabel = (id: OnboardingInterest) => t(`onboarding.interest.${id}.label`);
  const selectedTags = new Set(onboardingInterestTags(interests));

  let body: ReactNode;
  if (step === 1) {
    body = <>
      <header className="flex flex-col items-center gap-1.5 text-center">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-wd-secondary-text">{t("onboarding.eyebrow")}</span>
        <h2 id="onboarding-title" ref={headingRef} tabIndex={-1} className="text-balance font-display text-[22px] font-semibold leading-tight tracking-tight text-white outline-none md:text-[28px]">{t("onboarding.style.title")}</h2>
        <p className="max-w-md text-sm leading-relaxed text-wd-text-secondary md:text-[15px]">{t("onboarding.style.text")}</p>
      </header>
      <div className="mx-auto grid w-full max-w-[500px] grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:gap-4">
        {(["anime", "realistic"] as const).map(value => (
          <button key={value} type="button" aria-pressed={style === value} onClick={() => chooseStyle(value)} data-onboarding-style={value}
            className={`group relative isolate aspect-[16/10] overflow-hidden rounded-[22px] min-[480px]:aspect-[3/4] border-2 bg-[#1c1926] text-left transition-[transform,border-color] duration-200 hover:-translate-y-0.5 motion-reduce:transform-none data-[early-tap]:border-wd-primary ${style === value ? "border-wd-primary" : "border-transparent hover:border-wd-primary/60"}`}>
            <img src={`/images/onboarding/cover-${value}.webp`} alt="" fetchPriority="high" className="absolute inset-0 -z-20 h-full w-full object-cover object-[center_30%]" />
            <span aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgba(8,8,10,0.95)_0%,rgba(8,8,10,0.55)_30%,transparent_55%)]" />
            {style === value && <Tick />}
            <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-3 md:p-4">
              <span className="font-display text-xl font-semibold text-white md:text-[22px]">{t(`onboarding.style.${value}`)}</span>
              <span className="text-xs leading-snug text-zinc-300 md:text-[13px]">{t(`onboarding.style.${value}Hint`)}</span>
            </span>
          </button>
        ))}
      </div>
      <button type="button" aria-pressed={style === "any"} onClick={() => chooseStyle("any")} data-onboarding-style="any"
        className={`self-center rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors data-[early-tap]:border-wd-primary data-[early-tap]:text-white ${style === "any" ? "border-wd-primary text-white" : "border-white/20 text-wd-text-secondary hover:border-wd-primary hover:text-white"}`}>
        {t("onboarding.style.any")}
      </button>
      {source === "organic" && <script dangerouslySetInnerHTML={{ __html: EARLY_TAP_SCRIPT }} />}
    </>;
  } else if (step === 2) {
    const n = interests.length;
    body = <>
      <header className="flex flex-col items-center gap-1.5 text-center">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-wd-secondary-text">{t(`onboarding.styleLabel.${styleKey}`)}</span>
        <h2 id="onboarding-title" ref={headingRef} tabIndex={-1} className="text-balance font-display text-[22px] font-semibold leading-tight tracking-tight text-white outline-none md:text-[28px]">{t("onboarding.interests.title")}</h2>
        <p className="max-w-md text-sm leading-relaxed text-wd-text-secondary md:text-[15px]">{t("onboarding.interests.text")}</p>
      </header>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-3">
        {ONBOARDING_INTERESTS.map(({ id }, index) => {
          const active = interests.includes(id);
          return (
            <button key={id} type="button" aria-pressed={active} onClick={() => toggleInterest(id)}
              className={`relative isolate flex min-h-[104px] flex-col justify-end overflow-hidden rounded-2xl border-2 bg-[#1c1926] px-3 py-2.5 text-left transition-[border-color,opacity] md:min-h-[124px] md:px-3.5 ${active ? "border-wd-primary shadow-[0_0_0_3px_rgba(225,29,72,0.25)]" : "border-wd-border hover:border-white/25"} ${!active && n >= MAX_ONBOARDING_INTERESTS ? "opacity-45" : ""}`}>
              <img src={`/images/onboarding/genre-${id}-${tileStyle(index)}.webp`} alt="" loading="lazy" className="absolute inset-0 -z-20 h-full w-full object-cover" />
              <span aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgba(8,8,10,0.92)_10%,rgba(8,8,10,0.35)_70%,rgba(8,8,10,0.2))]" />
              {active && <Tick small />}
              <span className="text-[15px] font-bold leading-tight text-white">{interestLabel(id)}</span>
              <span className="hidden text-xs text-zinc-300 sm:block">{t(`onboarding.interest.${id}.hint`)}</span>
            </button>
          );
        })}
      </div>
      <fieldset className="flex flex-col items-center gap-2">
        <legend className="mb-2 w-full text-center text-xs font-semibold uppercase tracking-[0.06em] text-wd-text-secondary">{t("onboarding.interests.genderLabel")}</legend>
        <div className="flex flex-wrap justify-center gap-2">
          {([[null, "genderAny"], ["male", "genderMale"], ["female", "genderFemale"]] as const).map(([value, key]) => (
            <button key={key} type="button" aria-pressed={gender === value} onClick={() => setGender(value)}
              className={`rounded-full border px-3.5 py-2 text-[13px] font-semibold transition-colors ${gender === value ? "border-wd-secondary bg-wd-secondary/20 text-white" : "border-white/15 text-wd-text-secondary hover:border-white/35 hover:text-white"}`}>
              {t(`onboarding.interests.${key}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="sticky -bottom-5 flex flex-col items-center gap-2 bg-[linear-gradient(to_top,#141416_70%,transparent)] pb-1 pt-3">
        <button type="button" onClick={showResults} disabled={!n}
          className="min-h-12 w-full rounded-full bg-wd-primary px-7 text-[15px] font-bold text-white transition-colors hover:bg-wd-primary-hover disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-80">
          {t("onboarding.interests.show")}
        </button>
        <p className="min-h-5 text-center text-[12.5px] text-wd-text-secondary" aria-live="polite">
          {limitHint ? t("onboarding.interests.limit")
            : !n ? t("onboarding.interests.pickOne")
            : count === null ? " "
            : count === 0 ? t("onboarding.interests.noMatches", { selected: n })
            : t("onboarding.interests.matches", { count, selected: n })}
        </p>
      </div>
    </>;
  } else {
    const labels = interests.map(interestLabel).join(" · ");
    const characters = results.state === "ready" ? results.characters : [];
    body = <>
      <header className="flex flex-col items-center gap-1.5 text-center">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-wd-secondary-text">{t(`onboarding.styleLabel.${styleKey}`)} · {labels}</span>
        <h2 id="onboarding-title" ref={headingRef} tabIndex={-1} className="text-balance font-display text-[22px] font-semibold leading-tight tracking-tight text-white outline-none md:text-[28px]">
          {results.state === "loading" ? t("onboarding.results.loading") : t("onboarding.results.title", { count: characters.length })}
        </h2>
        {results.state === "ready" && characters.length > 0 && <p className="text-sm text-wd-text-secondary md:text-[15px]">{t("onboarding.results.text")}</p>}
      </header>
      {results.state === "loading" && (
        <div className="-mx-4 flex snap-x gap-3 overflow-x-hidden px-4 sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0" aria-hidden>
          {[0, 1, 2].map(i => <div key={i} className="aspect-[3/5] w-[82%] shrink-0 animate-pulse rounded-[18px] bg-wd-card sm:w-auto" />)}
        </div>
      )}
      {results.state === "error" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-wd-primary/30 bg-wd-card p-6 text-center">
          <p className="text-sm text-wd-text-secondary">{t("onboarding.results.error")}</p>
          <button type="button" onClick={() => { setResults({ state: "loading" }); setAttempt(value => value + 1); }}
            className="rounded-full bg-wd-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-wd-primary-hover">{t("onboarding.results.retry")}</button>
        </div>
      )}
      {results.state === "ready" && !characters.length && (
        <p className="rounded-2xl border border-wd-border bg-wd-card p-6 text-center text-sm text-wd-text-secondary">{t("onboarding.results.empty")}</p>
      )}
      {characters.length > 0 && (
        // Phones: the row shrinks to the space left on screen and the portraits give up height, so
        // "Start chatting" is visible without scrolling (down to a floor where the step scrolls instead).
        <div className={`-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] max-sm:min-h-[22rem] sm:mx-0 sm:grid sm:overflow-visible sm:px-0 md:gap-3.5 ${characters.length === 1 ? "sm:grid-cols-[minmax(0,300px)] sm:justify-center" : characters.length === 2 ? "sm:grid-cols-[repeat(2,minmax(0,280px))] sm:justify-center" : "sm:grid-cols-3"}`}>
          {characters.map((character, index) => {
            const name = localizedCharacterText(character, "name", locale) ?? character.name;
            const hook = getLocalizedCardDescription(character, locale);
            const greeting = localizedCharacterText(character, "greeting", locale);
            return (
              <article key={character.id} className={`flex min-w-0 shrink-0 snap-center flex-col overflow-hidden rounded-[18px] border border-wd-border bg-wd-card sm:w-auto ${characters.length === 1 ? "w-full" : "w-[82%]"}`}>
                <div className="relative isolate aspect-[4/5] max-sm:min-h-36 sm:aspect-square">
                  <img src={character.avatarUrl} alt={name} className="absolute inset-0 -z-10 h-full w-full object-cover object-[center_25%]" />
                  <span aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,#1a1a1a_2%,transparent_45%)]" />
                  <span className={`absolute left-2.5 top-2.5 max-w-[calc(100%-1.25rem)] truncate rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm ${character.fallback ? "text-wd-secondary-text" : "text-emerald-400"}`}>
                    {character.fallback ? t("onboarding.results.popular") : t("onboarding.results.matched", { list: character.matched.map(interestLabel).join(", ") })}
                  </span>
                </div>
                <div className="relative -mt-6 flex flex-1 flex-col gap-2 px-3.5 pb-3.5">
                  <h3 className="line-clamp-1 font-display text-[19px] font-semibold text-white">{name}</h3>
                  {hook && <p className="line-clamp-2 text-[13px] leading-snug text-zinc-300">{stripLeadingName(hook, name)}</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {character.tags.slice(0, 4).map(tag => (
                      <span key={tag} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${selectedTags.has(tag) ? "border-wd-primary/50 bg-wd-primary/15 text-rose-100" : "border-wd-border bg-[#1c1926] text-wd-text-secondary"}`}>
                        {characterTagLabel(tag, locale)}
                      </span>
                    ))}
                  </div>
                  {greeting && <p className="line-clamp-3 rounded-[4px_14px_14px_14px] bg-wd-elevated px-3 py-2 font-story text-[13.5px] italic leading-snug text-wd-story-muted sm:line-clamp-2"><Greeting text={greeting} /></p>}
                  <button type="button" disabled={leaving}
                    onClick={() => {
                      reachGoal(METRIKA_GOALS.onboardingChatStarted, { characterId: character.id, position: index + 1, fallback: character.fallback });
                      finish("completed", { chat: character.id });
                    }}
                    className="mt-auto min-h-11 rounded-full bg-wd-primary text-sm font-bold text-white transition-colors hover:bg-wd-primary-hover disabled:opacity-60">
                    {t("onboarding.results.start")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {results.state !== "loading" && (
        <div className="flex flex-wrap justify-center gap-2.5">
          {results.state === "ready" && characters.length > 0 && (
            <button type="button" onClick={() => { reachGoal(METRIKA_GOALS.onboardingReroll, { attempt: page + 1 }); setResults({ state: "loading" }); setPage(page + 1); }}
              className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-wd-text-secondary transition-colors hover:border-wd-primary hover:text-white">
              {t("onboarding.results.more")}
            </button>
          )}
          <button type="button" onClick={() => finish("completed", "catalog")}
            className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-wd-text-secondary transition-colors hover:border-wd-primary hover:text-white">
            {t("onboarding.results.catalog")}
          </button>
        </div>
      )}
    </>;
  }

  // Same layer as the site's other modals: above the desktop sidebar (z-[210]) and the header.
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title"
      className="fixed inset-0 z-[10050] grid place-items-center bg-black/70 backdrop-blur-md md:p-7">
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#13111a] md:h-auto md:max-h-full md:max-w-[780px] md:rounded-3xl md:border md:border-white/12 md:shadow-[0_30px_90px_rgba(0,0,0,0.7)]">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(520px_240px_at_90%_-10%,rgba(242,196,109,0.14),transparent_60%),radial-gradient(440px_240px_at_0%_110%,rgba(225,29,72,0.18),transparent_60%)]" />
        <div className="relative grid grid-cols-[44px_1fr_auto] items-center gap-3 px-3 pt-[max(12px,env(safe-area-inset-top))] md:px-5 md:pt-4">
          <button type="button" onClick={back} aria-label={t("onboarding.back")}
            className={`grid h-10 w-10 place-items-center rounded-full border border-wd-border bg-wd-card text-white ${step === 1 ? "invisible" : ""}`}>
            <FaChevronLeft size={14} aria-hidden />
          </button>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-wd-text-secondary">{t("onboarding.stepLabel", { step })}</span>
            <span className="flex w-full max-w-[220px] gap-1.5" aria-hidden>
              {[1, 2, 3].map(i => <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? "bg-wd-primary" : "bg-white/15"}`} />)}
            </span>
          </div>
          <button type="button" onClick={skip} className="px-1.5 py-2.5 text-[13.5px] font-semibold text-wd-text-secondary hover:text-white">{t("onboarding.skip")}</button>
        </div>
        <div key={step} className="relative flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 md:gap-5 md:px-7 md:pb-6">
          {body}
        </div>
      </div>
    </div>
  );
}
