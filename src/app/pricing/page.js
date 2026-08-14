"use client";

import Footer from "@/components/Footer";
import { SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import toast, { Toaster } from "react-hot-toast";
import { FaCheck, FaCrown, FaGlobe, FaRocket, FaStar } from "react-icons/fa";

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

function formatNumber(value) {
  return value.toLocaleString("ru-RU");
}

function handleSubscribe(planName, isFree) {
  if (isFree) {
    toast("Тариф «Старт» доступен всем пользователям по умолчанию", { icon: "✨" });
    return;
  }

  toast(`Подписка «${planName}» через Unitpay будет доступна позже`, { icon: "💳" });
}

export default function PricingPage() {
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <Toaster position="top-right" />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center gap-10 overflow-y-auto px-4 py-12 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="space-y-4 text-center">
          <div className="mb-1 inline-flex items-center gap-2 rounded-wd-pill border border-wd-secondary/30 bg-wd-secondary/10 px-3 py-1">
            <FaCrown className="text-xs text-wd-secondary" />
            <span className="text-[10px] font-black uppercase tracking-widest text-wd-secondary">
              Подписки
            </span>
          </div>
          <h1 className="text-3xl font-black uppercase tracking-tight text-white sm:text-4xl">
            Тарифы NewVerse
          </h1>
          <p className="mx-auto max-w-2xl text-sm leading-relaxed text-wd-text-secondary">
            Ежемесячные планы с бонусными VerseCoins, расширенным контекстом и приоритетом
            генерации. Выберите уровень для ваших историй и диалогов.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          {SUBSCRIPTION_PLANS.map((plan) => {
            const Icon = PLAN_ICONS[plan.id] ?? FaStar;
            const isFree = plan.monthlyPrice === 0;
            const isPopular = plan.id === "story";

            return (
              <article
                key={plan.id}
                className={`relative flex flex-col rounded-wd border bg-wd-card p-6 shadow-wd transition-all hover:-translate-y-1 hover:shadow-[0_12px_40px_rgba(108,99,255,0.12)] ${PLAN_ACCENTS[plan.id]} ${
                  isPopular ? "md:-mt-2 md:mb-2 md:scale-[1.02]" : ""
                }`}
              >
                {isPopular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-wd-pill bg-wd-secondary px-3 py-1 text-[9px] font-black uppercase tracking-wider text-white shadow">
                    Популярный
                  </span>
                )}

                <div className="mb-5 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-wd bg-[#0A0A0A] text-wd-secondary">
                    <Icon />
                  </div>
                  <div>
                    <h2 className="text-lg font-black text-white">{plan.name}</h2>
                    <p className="text-xs text-wd-text-secondary">
                      {isFree ? "Бесплатный тариф" : "Ежемесячная подписка"}
                    </p>
                  </div>
                </div>

                <div className="mb-5 space-y-1">
                  <p className="text-4xl font-black leading-none text-white">
                    {isFree ? "0 ₽" : `${formatNumber(plan.monthlyPrice)} ₽`}
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                    {isFree ? "навсегда" : "в месяц"}
                  </p>
                  {!isFree && (
                    <p className="text-xs text-wd-text-secondary">
                      или {formatNumber(plan.yearlyPrice)} ₽ / год
                    </p>
                  )}
                </div>

                <div className="mb-5 rounded-wd border border-wd-border bg-[#0A0A0A] p-4 text-sm">
                  <p className="font-black text-white">{formatNumber(plan.vcPerMonth)} VC / мес</p>
                  <p className="mt-1 text-xs text-wd-text-secondary">
                    Контекст {formatNumber(plan.contextTokens)} · множитель ×
                    {plan.contextMultiplier.toLocaleString("ru-RU")}
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
                  onClick={() => handleSubscribe(plan.name, isFree)}
                  disabled={isFree}
                  className={`w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98] ${PLAN_BUTTONS[plan.id]}`}
                >
                  {isFree ? "Текущий базовый тариф" : "Подписаться"}
                </button>
              </article>
            );
          })}
        </div>

        <p className="max-w-3xl text-center text-xs text-wd-text-secondary">
          При активации подписки на баланс начисляются бонусные VC согласно тарифу. Контекст и
          множитель памяти применяются автоматически. Оплата через Unitpay будет подключена в
          ближайшем обновлении.
        </p>
      </main>

      <Footer />
    </div>
  );
}
