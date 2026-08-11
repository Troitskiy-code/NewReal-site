"use client";

import Footer from "@/components/Footer";
import toast, { Toaster } from "react-hot-toast";
import { FaCheck, FaCrown, FaHeart, FaStar, FaUserFriends } from "react-icons/fa";

const PLANS = [
  {
    id: "acquaintance",
    name: "Знакомство",
    price: 399,
    vc: 4000,
    premiumMessages: 500,
    icon: FaStar,
    accent: "border-wd-border",
    buttonClass: "border border-wd-border bg-[#121212] hover:border-wd-secondary/50 hover:bg-wd-secondary/10",
    features: [
      "4 000 бонусных VC каждый месяц",
      "До 500 премиальных сообщений",
      "Доступ к платным моделям за VC",
      "Базовая модель бесплатна",
      "Без рекламы в чате",
    ],
  },
  {
    id: "friendship",
    name: "Дружба",
    price: 999,
    vc: 12000,
    premiumMessages: 1500,
    icon: FaUserFriends,
    popular: true,
    accent: "border-wd-secondary/50",
    buttonClass: "wd-button",
    features: [
      "12 000 бонусных VC каждый месяц",
      "До 1 500 премиальных сообщений",
      "Полный доступ к платным моделям",
      "Базовая модель бесплатна",
      "Приоритетная очередь ответов",
      "Без рекламы и ограничений интерфейса",
    ],
  },
  {
    id: "love",
    name: "Любовь",
    price: 1995,
    vc: 35000,
    premiumMessages: 4400,
    icon: FaHeart,
    accent: "border-wd-primary/50",
    buttonClass:
      "border border-wd-primary/50 bg-wd-primary/15 hover:bg-wd-primary hover:border-wd-primary text-white",
    features: [
      "35 000 бонусных VC каждый месяц",
      "До 4 400 премиальных сообщений",
      "Все премиальные модели без ограничений",
      "Базовая модель бесплатна",
      "Максимальный приоритет генерации",
      "Ранний доступ к новым персонажам",
      "Без рекламы и водяных знаков",
    ],
  },
];

function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU");
}

function handleSubscribe(planName: string) {
  toast(`Подписка «${planName}» через Unitpay будет доступна позже`, { icon: "💳" });
}

export default function PricingPage() {
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <Toaster position="top-right" />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center gap-10 overflow-y-auto px-4 py-12 scrollbar-subtle sm:px-6 lg:px-8">
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
            Ежемесячные планы с бонусными VerseCoins и премиальными сообщениями. Выберите уровень,
            который подходит вашему ритму общения с персонажами.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-3">
          {PLANS.map((plan) => {
            const Icon = plan.icon;
            return (
              <article
                key={plan.id}
                className={`relative flex flex-col rounded-wd border bg-wd-card p-6 shadow-wd transition-all hover:-translate-y-1 hover:shadow-[0_12px_40px_rgba(108,99,255,0.12)] ${plan.accent} ${
                  plan.popular ? "md:-mt-2 md:mb-2 md:scale-[1.02]" : ""
                }`}
              >
                {plan.popular && (
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
                    <p className="text-xs text-wd-text-secondary">Ежемесячная подписка</p>
                  </div>
                </div>

                <div className="mb-5 space-y-1">
                  <p className="text-4xl font-black leading-none text-white">
                    {formatNumber(plan.price)} ₽
                  </p>
                  <p className="text-xs font-bold uppercase tracking-wider text-wd-text-secondary">
                    в месяц
                  </p>
                </div>

                <div className="mb-5 rounded-wd border border-wd-border bg-[#0A0A0A] p-4 text-sm">
                  <p className="font-black text-white">
                    {formatNumber(plan.vc)} VC
                    <span className="ml-1 font-semibold text-wd-text-secondary">
                      (до {formatNumber(plan.premiumMessages)} премиальных сообщений)
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-wd-text-secondary">
                    1 премиальное сообщение ≈ 8 VC
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
                  onClick={() => handleSubscribe(plan.name)}
                  className={`w-full rounded-wd-pill py-3 text-sm font-bold transition-all active:scale-[0.98] ${plan.buttonClass}`}
                >
                  Подписаться
                </button>
              </article>
            );
          })}
        </div>

        <p className="max-w-2xl text-center text-xs text-wd-text-secondary">
          Премиальные сообщения — запросы к платным моделям. Базовая модель остаётся бесплатной для
          подписчиков. Оплата через Unitpay будет подключена в ближайшем обновлении.
        </p>
      </main>

      <Footer />
    </div>
  );
}
