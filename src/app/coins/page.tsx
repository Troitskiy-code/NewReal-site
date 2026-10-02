"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { FaArrowLeft, FaArrowRight, FaCheck, FaCoins, FaGift, FaLock } from "react-icons/fa";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import Footer from "@/components/Footer";
import CurrencySelector from "@/components/CurrencySelector";
import PaymentChargeSummary from "@/components/PaymentChargeSummary";
import ConvertedPrice from "@/components/ConvertedPrice";
import SubscriptionPlans from "@/components/SubscriptionPlans";
import { PurchaseStatusBanner, usePurchaseConfirmation } from "@/components/PurchaseStatusBanner";
import { useCurrency } from "@/components/CurrencyContext";
import { FIRST_VC_PACKAGE, VC_PACKAGES, type VcPackage } from "@/lib/vcPackages";
import { DAILY_BONUS_AMOUNTS, getBonusMultiplier } from "@/lib/dailyBonus";
import { coinsCharacterId, coinsChatHref } from "@/lib/coinsReturn";
import { redirectToRobokassa } from "@/lib/robokassaRedirect";
import { withLocale } from "@/lib/i18nConfig";
import { showError, showSuccess } from "@/lib/toast";

type Balance = {
  verseCoins: number; permanentCoins: number; canClaimBonus: boolean;
  currentBonusAmount: number; nextBonus: number; subscriptionActive: boolean;
  subscriptionLabel: string | null;
  bonusStreak: number; subscriptionType: string | null;
};
type Offer = { available: boolean; reserved: boolean };
type Character = { id: string; name: string; name_en?: string | null; imageUrl?: string | null };
type Quote = { name: string; cost: number };

function CheckoutModal({ pkg, paying, onBuy, onClose }: {
  pkg: VcPackage; paying: boolean; onBuy: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="vc-checkout-title"
    onCancel={event => { event.preventDefault(); if (!paying) onClose(); }}
    className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-wd-border bg-wd-card p-6 text-wd-text backdrop:bg-black/80">
    <h2 id="vc-checkout-title" className="text-xl font-bold text-white">{t("coins.checkoutTitle", { label: pkg.label })}</h2>
    <p className="mb-5 mt-2 text-sm text-wd-text-secondary">{locale === "en" ? "One payment. No subscription or automatic renewal. VC do not expire." : "Одна оплата. Без подписки и автопродления. VC не сгорают."}</p>
    <PaymentChargeSummary amountRub={pkg.price} context="vc" />
    <button autoFocus type="button" onClick={onBuy} disabled={paying} className="wd-button mt-5 w-full py-3 disabled:opacity-50">
      {paying ? t("coins.paying") : t("coins.goToPayment")}
    </button>
    <button type="button" onClick={onClose} disabled={paying} className="mt-3 w-full py-2 text-sm text-wd-text-secondary disabled:opacity-50">{t("common.cancel")}</button>
  </dialog>;
}

function CoinsShop({ characterId }: { characterId: string | null }) {
  const { status } = useSession();
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const router = useRouter();
  const { currency, setCurrency } = useCurrency();
  const text = (ru: string, en: string) => locale === "en" ? en : ru;
  const [balance, setBalance] = useState<Balance | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerError, setOfferError] = useState(false);
  const [balanceError, setBalanceError] = useState(false);
  const [character, setCharacter] = useState<Character | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [pendingPackage, setPendingPackage] = useState<VcPackage | null>(null);
  const [paying, setPaying] = useState(false);
  const { status: confirmationStatus, invId } = usePurchaseConfirmation();
  const chatHref = character ? coinsChatHref(character.id) : null;
  const personalName = character && (locale === "en" ? character.name_en || character.name : character.name);
  const firstVisible = status === "unauthenticated" || (status === "authenticated" && offer?.available);
  const heroPackage = firstVisible ? FIRST_VC_PACKAGE : VC_PACKAGES[0];
  const number = (value: number) => value.toLocaleString(locale);

  const refreshAccount = useCallback(async (signal?: AbortSignal) => {
    if (status !== "authenticated") return;
    await Promise.all([
      fetch("/api/user/balance", { signal, cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error("balance");
        const data: Balance = await response.json();
        if (!signal?.aborted) { setBalance(data); setBalanceError(false); }
      }).catch(() => { if (!signal?.aborted) setBalanceError(true); }),
      fetch("/api/coins/offer", { signal, cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error("offer");
        const data: Offer = await response.json();
        if (!signal?.aborted) { setOffer(data); setOfferError(false); }
      }).catch(() => { if (!signal?.aborted) setOfferError(true); }),
    ]);
  }, [status]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAccount(controller.signal);
    const update = () => { void refreshAccount(controller.signal); };
    window.addEventListener("verseCoinsUpdated", update);
    return () => { controller.abort(); window.removeEventListener("verseCoinsUpdated", update); };
  }, [refreshAccount]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models", { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => {
      if (!data || controller.signal.aborted) return;
      const models: Array<{ id: string; displayName: string; priceVC: number; isFreeForSubscribers: boolean }> = data.models ?? [];
      const model = models.find(item => item.id === data.selectedModelId) ?? models.find(item => item.priceVC > 0);
      if (model && model.priceVC > 0 && !(data.subscriptionActive && model.isFreeForSubscribers)) setQuote({ name: model.displayName, cost: model.priceVC });
    }).catch(() => {});
    if (characterId) void fetch(`/api/characters/${characterId}`, { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => {
      if (data && !controller.signal.aborted) setCharacter({ id: characterId, name: data.name, name_en: data.name_en, imageUrl: data.imageUrl });
    }).catch(() => {});
    return () => controller.abort();
  }, [characterId]);

  useEffect(() => {
    if (confirmationStatus !== "confirmed") return;
    const controller = new AbortController();
    void refreshAccount(controller.signal);
    return () => controller.abort();
  }, [confirmationStatus, invId, refreshAccount]);

  const openCheckout = (pkg: VcPackage) => {
    if (status === "loading") return;
    if (status !== "authenticated") {
      const destination = withLocale(`/coins${characterId ? `?characterId=${characterId}` : ""}`, locale);
      router.push(`${withLocale("/login", locale)}?callbackUrl=${encodeURIComponent(destination)}`);
      return;
    }
    setPendingPackage(pkg);
  };
  const handleBuy = async () => {
    if (!pendingPackage || paying) return;
    setPaying(true);
    try {
      const response = await fetch("/api/payment/create", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: pendingPackage.id, characterId }) });
      const data = await response.json();
      if (response.ok && redirectToRobokassa(data)) return;
      showError(data.code === "FIRST_PACK_UNAVAILABLE"
        ? text("Первый пакет уже недоступен. Выберите обычный пакет.", "The introductory offer is no longer available. Choose a regular pack.")
        : data.error || t("coins.paymentError"));
      if (data.code === "FIRST_PACK_UNAVAILABLE") { setPendingPackage(null); await refreshAccount(); }
    } catch { showError(t("coins.createPaymentError")); }
    setPaying(false);
  };
  const claimBonus = async () => {
    setClaiming(true);
    try {
      const response = await fetch("/api/daily-bonus", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("coins.bonusError"));
      showSuccess(data.message || t("coins.bonusReceived"));
      window.dispatchEvent(new CustomEvent("verseCoinsUpdated", { detail: { verseCoins: data.verseCoins } }));
    } catch (error) { showError(error instanceof Error ? error.message : t("coins.bonusError")); }
    await refreshAccount(); setClaiming(false);
  };
  const estimate = (pkg: VcPackage) => quote ? `${text("Ориентир", "Estimate")}: ~${number(Math.floor(pkg.vc / quote.cost))} ${text("ответов на модели", "replies with")} ${quote.name}` : null;
  const offerLoading = status === "loading" || (status === "authenticated" && !offer && !offerError);
  const bonusScale = DAILY_BONUS_AMOUNTS.map(amount => Math.round(amount * getBonusMultiplier(
    balance?.subscriptionActive ? balance.subscriptionType : null
  )));
  // The server's preview accounts for missed days and the seven-day rollover.
  const bonusDay = balance?.canClaimBonus
    ? Math.max(1, bonusScale.indexOf(balance.currentBonusAmount) + 1)
    : Math.min(Math.max(balance?.bonusStreak ?? 1, 1), 7);
  const completedBonusDays = balance?.canClaimBonus ? bonusDay - 1 : bonusDay;

  return <div className="min-h-dvh bg-wd-bg text-wd-text">
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 sm:space-y-10 sm:px-6 sm:py-8 lg:px-8 lg:py-12">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-wd-border pb-5">
        <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-wd-text-secondary"><FaCoins className="text-wd-secondary" /> VerseCoins</span>
        <CurrencySelector value={currency} onChange={setCurrency} />
      </div>
      <PurchaseStatusBanner ns="coins" />
      {confirmationStatus === "confirmed" && chatHref && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-wd-secondary/30 bg-wd-card p-5">
        <span className="font-medium">{text("VC зачислены. Ваша история ждёт продолжения.", "VC received. Your story is ready to continue.")}</span>
        <LocaleLink href={chatHref} className="wd-button inline-flex items-center gap-2 px-5 py-3">{text("Вернуться в диалог", "Return to chat")} <FaArrowRight /></LocaleLink>
      </div>}
      <section aria-labelledby="coins-hero-title" className="grid items-center gap-5 sm:gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
        <div className="space-y-4 sm:space-y-6">
          {chatHref && <LocaleLink href={chatHref} className="inline-flex items-center gap-2 text-sm text-wd-text-secondary hover:text-white"><FaArrowLeft /> {text("Назад в диалог", "Back to chat")}</LocaleLink>}
          <h1 id="coins-hero-title" className="max-w-xl break-words text-3xl font-black leading-[1.12] tracking-tight text-white sm:text-5xl">{personalName ? text(`Продолжите историю с ${personalName}`, `Continue your story with ${personalName}`) : text("Вашей истории нужно продолжение", "Your story deserves another chapter")}</h1>
          <p className="hidden max-w-lg text-base leading-relaxed text-wd-text-secondary sm:block">{text("Пополните баланс и общайтесь с персонажами в своём ритме. Начните с небольшой покупки — без подписки и обязательств.", "Top up and chat with characters at your own pace. Start small, without a subscription or commitment.")}</p>
          {character && <div className="flex items-center gap-3">
            {character.imageUrl ? <Image unoptimized width={56} height={56} src={`/api/characters/${character.id}/avatar`} alt="" className="h-14 w-14 rounded-2xl object-cover" /> : <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-wd-card text-xl font-bold">{personalName?.slice(0, 1)}</div>}
            <div><p className="font-bold text-white">{personalName}</p><p className="text-xs text-wd-text-secondary">{text("После подтверждения оплаты вернёмся к этому диалогу", "Return to this chat after payment confirmation")}</p></div>
          </div>}
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-wd-text-secondary sm:text-sm">
            <span className="inline-flex items-center gap-2"><FaCheck className="text-wd-secondary" /> {text("VC не сгорают", "VC never expire")}</span>
            <span className="inline-flex items-center gap-2"><FaLock className="text-wd-secondary" /> {text("Оплата через Robokassa", "Payment via Robokassa")}</span>
          </div>
        </div>
        <div data-testid="coins-hero-offer" className="relative overflow-hidden rounded-3xl border border-wd-secondary/40 bg-wd-card p-5 sm:p-8">
          <div className="flex items-center justify-between gap-3"><span className="rounded-full bg-wd-secondary/15 px-3 py-1 text-xs font-bold text-wd-secondary">{firstVisible ? text("Первое знакомство", "First introduction") : text("Разовое пополнение", "One-time top-up")}</span><FaCoins className="text-2xl text-wd-secondary" /></div>
          <p className="mt-4 text-4xl font-black tracking-tight text-white sm:mt-7 sm:text-5xl">{number(heroPackage.vc)} <span className="text-xl font-medium text-wd-text-secondary">VC</span></p>
          <p className="mt-2 hidden text-sm text-wd-text-secondary sm:block">{text("Для новых сцен и разговоров", "For new scenes and conversations")}</p>
          <p className="mt-3 text-3xl font-bold text-white sm:mt-6"><ConvertedPrice amountRub={heroPackage.price} /></p>
          <p className="mt-2 text-xs text-wd-text-secondary">{text("Один платёж · без автопродления", "One payment · no auto-renewal")}{currency !== "RUB" ? text(` · Списание ${heroPackage.price} ₽`, ` · Charged ${heroPackage.price} RUB`) : ""}</p>
          <button type="button" data-testid="coins-hero-buy" disabled={offerLoading || (status === "authenticated" && offerError)} onClick={() => openCheckout(heroPackage)} className="wd-button mt-4 flex w-full items-center justify-center gap-2 py-3.5 disabled:opacity-50 sm:mt-6">
            {offerLoading ? text("Проверяем предложение…", "Checking availability…") : status === "authenticated" && offerError ? text("Предложение временно недоступно", "Offer temporarily unavailable") : text(`Получить ${number(heroPackage.vc)} VC`, `Get ${number(heroPackage.vc)} VC`)} <FaArrowRight />
          </button>
          {estimate(heroPackage) && <p className="mt-4 text-xs leading-relaxed text-wd-text-secondary">{estimate(heroPackage)}. {text("Количество зависит от выбранной модели.", "The number depends on the model you choose.")}</p>}
          {firstVisible && <p className="mt-4 border-t border-wd-border pt-4 text-xs leading-relaxed text-wd-text-secondary">{text("Один первый пакет на аккаунт до первой покупки. Подписка и генерации аватаров не включены.", "One introductory pack per account before your first purchase. Subscription and avatar generations are not included.")}</p>}
          {firstVisible && offer?.reserved && <p className="mt-2 text-xs text-wd-text-secondary">{text("Первый пакет уже зарезервирован: продолжите оплату того же счёта.", "Your introductory pack is reserved: continue paying the same invoice.")}</p>}
          {offerError && <button type="button" onClick={() => { void refreshAccount(); }} className="mt-3 text-sm text-wd-secondary underline">{t("common.retry")}</button>}
        </div>
      </section>
      {status === "authenticated" && <section aria-label={t("coins.balance")} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-wd-border bg-wd-card px-5 py-4">
        <div><p className="text-xs text-wd-text-secondary">{t("coins.balance")}</p><p className="mt-1 text-xl font-bold text-white">{balance ? `${number(balance.verseCoins)} VC` : balanceError ? t("coins.loadError") : text("Загрузка…", "Loading…")}</p>{balance?.subscriptionActive && <p className="mt-1 text-xs text-wd-text-secondary">{balance.subscriptionLabel}</p>}</div>
        {balanceError && <button type="button" onClick={() => { void refreshAccount(); }} className="text-sm text-wd-secondary underline">{t("common.retry")}</button>}
      </section>}
      {status === "authenticated" && balance && <section aria-labelledby="coins-daily-bonus-title" className="space-y-5 rounded-2xl border border-wd-border bg-wd-card p-5 sm:p-6">
        <div className="flex items-center gap-2"><FaGift className="text-wd-primary" /><h2 id="coins-daily-bonus-title" className="text-base font-bold text-white">{t("coins.dailyBonus")}</h2></div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-wd-text-secondary">
            <span>{t("coins.streakDay", { day: bonusDay })}</span>
            <span>{balance.canClaimBonus ? text("Сегодня", "Today") : text("Завтра", "Tomorrow")} <strong className="text-white">+{balance.canClaimBonus ? balance.currentBonusAmount : balance.nextBonus} VC</strong></span>
          </div>
          <div role="progressbar" aria-labelledby="coins-daily-bonus-title" aria-valuemin={0} aria-valuemax={7} aria-valuenow={completedBonusDays} className="h-3 overflow-hidden rounded-full bg-[#0A0A0A]">
            <div className="h-full rounded-full bg-gradient-to-r from-wd-primary to-wd-secondary transition-all motion-reduce:transition-none" style={{ width: `${completedBonusDays / 7 * 100}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-wd-text-secondary sm:text-xs">{bonusScale.map((amount, index) => <span key={index} className={index < completedBonusDays ? "font-semibold text-wd-primary" : ""}>{amount}</span>)}</div>
        </div>
        {!balance.canClaimBonus && <p className="text-xs text-wd-text-secondary">{t("coins.alreadyClaimed")}</p>}
        <button type="button" onClick={claimBonus} disabled={claiming || !balance.canClaimBonus} className="wd-button flex w-full items-center justify-center gap-2 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"><FaGift />{claiming ? t("coins.claiming") : balance.canClaimBonus ? t("coins.claim", { amount: balance.currentBonusAmount }) : text(`Завтра +${balance.nextBonus} VC`, `Tomorrow +${balance.nextBonus} VC`)}</button>
      </section>}
      <section aria-labelledby="coins-packs-title" className="space-y-5">
        <div><h2 id="coins-packs-title" className="text-2xl font-bold text-white">{text("Больше пространства для вашей истории", "More room for your story")}</h2><p className="mt-2 text-sm text-wd-text-secondary">{text("Разовые пакеты для любого аккаунта. Пополняйте баланс, когда захотите.", "One-time packs for every account. Top up whenever you like.")}</p></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{VC_PACKAGES.map((pkg, index) => <article key={pkg.id} data-testid={`vc-pack-${pkg.id}`} className="flex flex-col rounded-2xl border border-wd-border bg-wd-card p-5">
          <p className="text-xs font-medium text-wd-text-secondary">{[text("Для нескольких сцен", "A few scenes"), text("Для развития сюжета", "Build your story"), text("Для долгих разговоров", "Long conversations"), text("Для нескольких историй", "Multiple stories"), text("Для больших миров", "Bigger worlds"), text("Для увлечённых авторов", "Dedicated storytellers")][index]}</p>
          <h3 className="mt-3 text-2xl font-bold text-white">{number(pkg.vc)} VC</h3><p className="mt-3 text-lg font-semibold"><ConvertedPrice amountRub={pkg.price} /></p>
          {estimate(pkg) && <p className="mt-2 text-xs leading-relaxed text-wd-text-secondary">{estimate(pkg)}</p>}
          <button type="button" onClick={() => openCheckout(pkg)} disabled={status === "loading"} className="mt-5 rounded-full border border-wd-border px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-wd-secondary hover:bg-wd-secondary/10 disabled:opacity-50">{t("coins.buy")}</button>
        </article>)}</div>
      </section>
      <section className="space-y-5 border-t border-wd-border pt-8"><div><h2 className="text-2xl font-bold text-white">{text("Общаетесь регулярно?", "Chatting regularly?")}</h2><p className="mt-2 text-sm text-wd-text-secondary">{text("Подписка — отдельный формат с месячными VC, памятью диалогов и генерациями аватаров.", "Subscriptions include monthly VC, conversation memory and avatar generations.")}</p></div><SubscriptionPlans showHero={false} showStatus={false} showCurrencySelector={false} /></section>
      <section className="border-t border-wd-border pt-8"><h2 className="mb-4 text-xl font-bold text-white">{text("Перед покупкой", "Before you buy")}</h2>
        {[
          [text("Что можно делать с VC?", "What can I do with VC?"), text("Оплачивать ответы моделей в диалогах. Цена ответа зависит от выбранной модели и показана в чате. Пакет VC не активирует подписку и не добавляет генерации аватаров.", "Pay for model replies in chats. Reply prices depend on the model and are shown in chat. VC packs do not activate a subscription or add avatar generations.")],
          [text("У купленных VC есть срок действия?", "Do purchased VC expire?"), text("VC из разовых пакетов не сгорают. Месячные VC подписки учитываются отдельно и действуют по условиям подписки.", "VC from one-time packs never expire. Monthly subscription VC are separate and follow subscription terms.")],
          [text("Когда обновится баланс?", "When will my balance update?"), text("После подтверждения платежа от Robokassa. Возврат на сайт может произойти раньше: в этом случае покажем статус ожидания.", "After Robokassa confirms payment. You may return to the site earlier; in that case we show a pending status.")],
        ].map(([question, answer]) => <details key={question} className="border-b border-wd-border py-4"><summary className="cursor-pointer text-sm font-semibold text-white">{question}</summary><p className="mt-3 max-w-3xl text-sm leading-relaxed text-wd-text-secondary">{answer}</p></details>)}
        <p className="mt-5 text-sm text-wd-text-secondary">{text("Нужна помощь с оплатой?", "Need help with payment?")} <LocaleLink href="/support?topic=payment" className="text-wd-secondary underline">{text("Написать в поддержку", "Contact support")}</LocaleLink></p>
      </section>
    </main>
    {pendingPackage && <CheckoutModal pkg={pendingPackage} paying={paying} onBuy={handleBuy} onClose={() => { if (!paying) setPendingPackage(null); }} />}
    <Footer />
  </div>;
}

function CoinsEntry() {
  const { data: session } = useSession();
  const search = useSearchParams();
  const characterId = coinsCharacterId(search.get("characterId"));
  return <CoinsShop key={`${session?.user?.id ?? "guest"}:${characterId ?? "none"}`} characterId={characterId} />;
}

export default function CoinsPage() {
  return <Suspense fallback={<div className="min-h-dvh bg-wd-bg p-8 text-wd-text-secondary">VerseCoins…</div>}><CoinsEntry /></Suspense>;
}
