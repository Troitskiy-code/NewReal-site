"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import LocaleLink from "@/components/LocaleLink";
import { useRouter } from "next/navigation";
import Footer from "@/components/Footer";
import { SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import { reachGoal, subscriptionGoal } from "@/lib/metrika";
import toast, { Toaster } from "react-hot-toast";
import { FaCheck, FaCrown, FaGlobe, FaRocket, FaStar } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { dateLocale, withLocale } from "@/lib/i18nConfig";
import { useCurrentLocale } from "@/components/LocaleLink";

const PLAN_ICONS = {
  start: FaStar,
  dialog: FaRocket,
  story: FaCrown,
  universe: FaGlobe,
};

const PLAN_ACCENTS = {
  start: "border-wd-border",
  dialog: "border-wd-border",
  story: "border-wd-secondary/50",
  universe: "border-wd-primary/50",
};

const PLAN_BUTTONS = {
  start:
    "border border-wd-border bg-[#121212] text-wd-text-secondary cursor-default",
  dialog:
    "border border-wd-border bg-[#121212] hover:border-wd-secondary/50 hover:bg-wd-secondary/10",
  story: "wd-button",
  universe:
    "border border-wd-primary/50 bg-wd-primary/15 hover:bg-wd-primary hover:border-wd-primary text-white",
};

function metrikaPlanSlug(planId) {
  return planId === "story" ? "history" : planId;
}

function formatNumber(value, locale = "ru") {
  return value.toLocaleString(dateLocale(locale));
}

function formatDate(value, locale = "ru") {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(dateLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function PricingPage() {
  const { status } = useSession();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const locale = useCurrentLocale();
  const [isYearly, setIsYearly] = useState(false);
  const [subscribingPlanId, setSubscribingPlanId] = useState(null);
  const [balance, setBalance] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [applyMode, setApplyMode] = useState("immediate");
  const [recurringConsent, setRecurringConsent] = useState(false);
  const [cancellingPending, setCancellingPending] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/user/balance");
      if (!res.ok) {
        setBalance(null);
        return;
      }
      const data = await res.json();
      setBalance(data);
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchBalance();
    }
  }, [status, fetchBalance]);

  const hasActiveSubscription = Boolean(
    balance?.subscriptionType &&
      balance.subscriptionType !== "none" &&
      balance.subscriptionType !== "start" &&
      balance.subscriptionEnd &&
      new Date(balance.subscriptionEnd) > new Date()
  );

  const startCheckout = async (plan, mode) => {
    setSubscribingPlanId(plan.id);
    const toastId = toast.loading(t("pricing.creatingPayment"));

    try {
      const res = await fetch("/api/subscription/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          period: isYearly ? "year" : "month",
          applyMode: mode,
          recurringConsent: true,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.url) {
        throw new Error(data.error || t("pricing.paymentError"));
      }

      toast.dismiss(toastId);
      window.location.href = data.url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("pricing.paymentError"), {
        id: toastId,
      });
      setSubscribingPlanId(null);
    }
  };

  const handleSubscribe = (plan) => {
    const isFree = plan.monthlyPrice === 0;
    if (isFree) {
      toast(t("pricing.startDefault"), { icon: "✨" });
      return;
    }

    const goal = subscriptionGoal(plan.id);
    if (goal) reachGoal(goal);

    if (status !== "authenticated") {
      router.push(withLocale("/login", locale));
      return;
    }

    setApplyMode("immediate");
    setRecurringConsent(false);
    setSelectedPlan(plan);
  };

  const closeCheckout = () => {
    setSelectedPlan(null);
    setRecurringConsent(false);
  };

  const handlePay = async () => {
    if (!selectedPlan) return;
    if (!recurringConsent) return;
    const goal = subscriptionGoal(selectedPlan.id);
    if (goal) reachGoal(goal);
    const mode = hasActiveSubscription ? applyMode : "immediate";
    const plan = selectedPlan;
    closeCheckout();
    await startCheckout(plan, mode);
  };

  const handleCancelPending = async () => {
    setCancellingPending(true);
    try {
      const res = await fetch("/api/subscription/pending/cancel", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("pricing.cancelPendingError"));
      }
      setBalance((prev) => (prev ? { ...prev, ...data } : data));
      toast.success(t("pricing.cancelPendingSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("pricing.cancelPendingError"));
    } finally {
      setCancellingPending(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <Toaster position="top-right" />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center gap-10 overflow-y-auto px-4 py-12 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="space-y-4 text-center">
          <div className="mb-1 inline-flex items-center gap-2 rounded-wd-pill border border-wd-secondary/30 bg-wd-secondary/10 px-3 py-1">
            <FaCrown className="text-xs text-wd-secondary" />
            <span className="text-[10px] font-black uppercase tracking-widest text-wd-secondary">
              {t("pricing.badge")}
            </span>
          </div>
          <h1 className="text-3xl font-black uppercase tracking-tight text-white sm:text-4xl">
            {t("pricing.title")}
          </h1>
          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-wd-text-secondary">
            {t("pricing.subtitle")}
          </p>
        </div>

        {status === "authenticated" && (
          <div className="flex w-full max-w-3xl flex-col gap-3">
            <div className="rounded-wd border border-wd-secondary/30 bg-wd-card px-4 py-3 text-center text-sm text-white">
              {hasActiveSubscription
                ? t("pricing.activeUntil", {
                    label: balance.subscriptionLabel || t("pricing.subscribe"),
                    date: formatDate(balance.subscriptionEnd, i18n.language),
                  })
                : t("pricing.noActive")}
            </div>
            {balance?.pendingSubscriptionType && balance.pendingSubscriptionLabel && (
              <div className="flex flex-col items-center gap-3 rounded-wd border border-wd-border bg-wd-card px-4 py-3 text-center sm:flex-row sm:justify-between sm:text-left">
                <p className="text-sm text-wd-text-secondary">
                  {t("pricing.pending", {
                    label: balance.pendingSubscriptionLabel,
                    date: formatDate(balance.subscriptionEnd, i18n.language),
                  })}
                </p>
                <button
                  type="button"
                  onClick={handleCancelPending}
                  disabled={cancellingPending}
                  className="shrink-0 rounded-wd-pill border border-wd-border px-4 py-2 text-xs font-bold text-white transition-colors hover:border-wd-primary disabled:opacity-50"
                >
                  {cancellingPending ? t("pricing.cancelling") : t("pricing.cancelPending")}
                </button>
              </div>
            )}
            {balance?.recurringSetupRequired && (
              <div className="rounded-wd border border-wd-primary/40 bg-wd-card px-4 py-3 text-center text-sm text-wd-text-secondary">
                {t("pricing.recurringMissing")}
              </div>
            )}
          </div>
        )}

        <div className="inline-flex rounded-wd-pill border border-wd-border bg-wd-card p-1">
          <button
            type="button"
            onClick={() => setIsYearly(false)}
            className={`rounded-wd-pill px-5 py-2 text-sm font-bold transition-all ${
              !isYearly
                ? "bg-wd-secondary text-white shadow"
                : "text-wd-text-secondary hover:text-white"
            }`}
          >
            {t("pricing.month")}
          </button>
          <button
            type="button"
            onClick={() => setIsYearly(true)}
            className={`rounded-wd-pill px-5 py-2 text-sm font-bold transition-all ${
              isYearly
                ? "bg-wd-secondary text-white shadow"
                : "text-wd-text-secondary hover:text-white"
            }`}
          >
            {t("pricing.year")}
          </button>
        </div>

        <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          {SUBSCRIPTION_PLANS.map((plan) => {
            const Icon = PLAN_ICONS[plan.id] ?? FaStar;
            const isFree = plan.monthlyPrice === 0;
            const isPopular = plan.id === "story";
            const price = isYearly ? plan.yearlyPrice : plan.monthlyPrice;

            return (
              <article
                key={plan.id}
                className={`relative flex flex-col rounded-wd border bg-wd-card p-6 shadow-wd transition-all hover:-translate-y-1 hover:shadow-[0_12px_40px_rgba(108,99,255,0.12)] ${PLAN_ACCENTS[plan.id]} ${
                  isPopular ? "md:-mt-2 md:mb-2 md:scale-[1.02]" : ""
                }`}
              >
                {isPopular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-wd-pill bg-wd-secondary px-3 py-1 text-[9px] font-black uppercase tracking-wider text-white shadow">
                    {t("pricing.popular")}
                  </span>
                )}

                <div className="mb-5 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-wd bg-[#0A0A0A] text-wd-secondary">
                    <Icon />
                  </div>
                  <div>
                    <h2 className="text-lg font-black text-white">{plan.name}</h2>
                    <p className="text-xs text-wd-text-secondary">
                      {isFree ? t("profile.freePlan") : isYearly ? t("pricing.yearlyPlan") : t("pricing.monthlyPlan")}
                    </p>
                  </div>
                </div>

                <div className="mb-5 space-y-1">
                  <p className="text-4xl font-black leading-none text-white">
                    {isFree ? "0 ₽" : `${formatNumber(price, i18n.language)} ₽`}
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                    {isFree ? t("pricing.forever") : isYearly ? t("pricing.perYear") : t("pricing.perMonth")}
                  </p>
                </div>

                <div className="mb-5 rounded-wd border border-wd-border bg-[#0A0A0A] p-4 text-sm">
                  <p className="font-black text-white">{t("pricing.vcPerMonth", { count: formatNumber(plan.vcPerMonth, i18n.language) })}</p>
                  <p className="mt-1 text-xs text-wd-text-secondary">
                    {t("pricing.context", {
                      tokens: formatNumber(plan.contextTokens, i18n.language),
                      multiplier: plan.contextMultiplier.toLocaleString(dateLocale(i18n.language)),
                    })}
                  </p>
                </div>

                <ul className="mb-6 flex-1 space-y-2.5 border-t border-wd-border pt-5 text-xs text-wd-text-secondary">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <FaCheck className="mt-0.5 shrink-0 text-[10px] text-wd-primary" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  id={`subscribe-${metrikaPlanSlug(plan.id)}`}
                  data-metrika={`subscribe-${metrikaPlanSlug(plan.id)}`}
                  onClick={() => handleSubscribe(plan)}
                  disabled={isFree || subscribingPlanId === plan.id}
                  className={`w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98] ${PLAN_BUTTONS[plan.id]}`}
                >
                  {isFree
                    ? t("pricing.currentBase")
                    : subscribingPlanId === plan.id
                      ? t("pricing.redirecting")
                      : t("pricing.subscribe")}
                </button>
              </article>
            );
          })}
        </div>

        <p className="max-w-3xl text-center text-xs text-wd-text-secondary">
          {t("pricing.footnote")}
        </p>
      </main>

      {selectedPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="wd-card w-full max-w-md space-y-5 p-6">
            <h2 className="text-lg font-black text-white">{t("pricing.checkoutTitle", { name: selectedPlan.name })}</h2>
            <div className="space-y-3 text-sm text-wd-text-secondary">
              <label className="flex cursor-pointer items-start gap-3 rounded-wd border border-wd-border bg-[#0A0A0A] p-3">
                <input
                  type="radio"
                  name="applyMode"
                  value="immediate"
                  checked={applyMode === "immediate"}
                  onChange={() => setApplyMode("immediate")}
                  className="mt-1"
                />
                <span>
                  <span className="block font-bold text-white">{t("pricing.applyNow")}</span>
                  {t("pricing.applyNowHint")}
                </span>
              </label>
              {hasActiveSubscription && (
                <label className="flex cursor-pointer items-start gap-3 rounded-wd border border-wd-border bg-[#0A0A0A] p-3">
                  <input
                    type="radio"
                    name="applyMode"
                    value="afterExpiry"
                    checked={applyMode === "afterExpiry"}
                    onChange={() => setApplyMode("afterExpiry")}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-bold text-white">{t("pricing.applyLater")}</span>
                    {t("pricing.applyLaterHint")}
                  </span>
                </label>
              )}
            </div>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-wd border border-wd-border bg-[#0A0A0A] p-3 text-sm text-wd-text-secondary">
                <input
                  type="checkbox"
                  checked={recurringConsent}
                  onChange={(e) => setRecurringConsent(e.target.checked)}
                  className="mt-1 accent-[#6C63FF]"
                />
                <span>
                  {t("pricing.offerConsent")}{" "}
                  <LocaleLink
                    href="/offer"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-wd-secondary underline hover:text-white"
                  >
                    {t("pricing.offerLink")}
                  </LocaleLink>
                </span>
              </label>
              {!recurringConsent && (
                <p className="text-xs text-red-400">
                  {t("pricing.consentRequired")}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                id={`subscribe-pay-${metrikaPlanSlug(selectedPlan.id)}`}
                data-metrika={`subscribe-pay-${metrikaPlanSlug(selectedPlan.id)}`}
                onClick={handlePay}
                disabled={Boolean(subscribingPlanId) || !recurringConsent}
                className="wd-button w-full py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("pricing.goToPayment")}
              </button>
              <button
                type="button"
                onClick={closeCheckout}
                className="w-full py-2 text-sm font-medium text-wd-text-secondary hover:text-white"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
