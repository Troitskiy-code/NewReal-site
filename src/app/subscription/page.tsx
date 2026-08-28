"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import { SUBSCRIPTION_PLANS, type SubscriptionPlan } from "@/lib/chatEconomy";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaCheck, FaCrown, FaGlobe, FaRocket, FaStar } from "react-icons/fa";

type SubscriptionBalance = {
  subscriptionType: string | null;
  subscriptionEnd: string | null;
  subscriptionActive: boolean;
  subscriptionLabel: string | null;
  daysRemaining: number;
  pendingSubscriptionType: string | null;
  pendingSubscriptionEnd: string | null;
  pendingSubscriptionLabel: string | null;
  recurringSetupRequired?: boolean;
};

const PLAN_ICONS = {
  start: FaStar,
  dialog: FaRocket,
  story: FaCrown,
  universe: FaGlobe,
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function daysLabel(days: number): string {
  const abs = Math.abs(days);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${days} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${days} дня`;
  return `${days} дней`;
}

export default function SubscriptionPage() {
  const { status } = useSession();
  const [balance, setBalance] = useState<SubscriptionBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(null);
  const [changing, setChanging] = useState(false);

  const fetchBalance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get<SubscriptionBalance>("/api/user/balance");
      setBalance(data);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось загрузить подписку";
      setError(message);
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchBalance();
    }
  }, [status, fetchBalance]);

  const handleChange = async (applyMode: "immediate" | "afterExpiry") => {
    if (!selectedPlan) return;
    setChanging(true);
    try {
      const { data } = await axios.post<SubscriptionBalance>("/api/subscription/change", {
        planId: selectedPlan.id,
        applyMode,
      });
      setBalance(data);
      setSelectedPlan(null);
      toast.success(
        applyMode === "immediate"
          ? `Тариф «${selectedPlan.name}» применён`
          : `Тариф «${selectedPlan.name}» будет включён после окончания текущей подписки`
      );
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось изменить подписку";
      toast.error(message);
    } finally {
      setChanging(false);
    }
  };

  if (status === "loading" || (status === "authenticated" && loading && !balance)) {
    return (
      <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
        <Footer />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
        <Toaster position="top-right" />
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
          <FaCrown className="text-4xl text-wd-secondary opacity-40" />
          <h1 className="text-xl font-black uppercase tracking-tight">Управление подпиской</h1>
          <p className="max-w-sm text-xs text-wd-text-secondary">
            Войдите в аккаунт, чтобы смотреть тариф и менять подписку.
          </p>
          <Link href="/login" className="wd-button px-6 py-2.5 text-sm">
            Войти
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const currentPlanId = balance?.subscriptionActive
    ? balance.subscriptionType
    : "start";
  const canDefer = Boolean(balance?.subscriptionActive && balance.subscriptionEnd);

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <Toaster position="top-right" />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 overflow-y-auto px-4 py-10 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-wd-secondary">
            <FaCrown className="text-lg" />
            <span className="text-xs font-bold uppercase tracking-widest">Подписка</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white">Управление подпиской</h1>
          <p className="max-w-xl text-sm text-wd-text-secondary">
            Текущий тариф, срок действия и переход на другой план.
          </p>
        </div>

        {error && (
          <section className="wd-card space-y-3 border-wd-primary/30 p-6 text-center">
            <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
            <p className="text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={fetchBalance} className="wd-button px-5 py-2.5 text-xs">
              Повторить
            </button>
          </section>
        )}

        {balance && (
          <section className="wd-card space-y-3 border-wd-secondary/30 p-6">
            <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">
              Текущий тариф
            </p>
            <h2 className="text-2xl font-black text-white">{balance.subscriptionLabel || "Старт"}</h2>
            {balance.subscriptionActive && balance.subscriptionEnd ? (
              <>
                <p className="text-sm text-wd-text-secondary">
                  Действует до {formatDate(balance.subscriptionEnd)}
                </p>
                <p className="text-sm font-bold text-white">
                  Осталось {daysLabel(balance.daysRemaining)}
                </p>
              </>
            ) : (
              <p className="text-sm text-wd-text-secondary">Бесплатный тариф без срока действия</p>
            )}
            {balance.pendingSubscriptionLabel && balance.pendingSubscriptionEnd && (
              <p className="rounded-wd border border-wd-border bg-[#0A0A0A] p-3 text-sm text-wd-text-secondary">
                После окончания текущей подписки будет включён тариф «{balance.pendingSubscriptionLabel}»
                ({formatDate(balance.pendingSubscriptionEnd)}).
              </p>
            )}
            {balance.recurringSetupRequired && (
              <p className="rounded-wd border border-wd-primary/40 bg-[#0A0A0A] p-3 text-sm text-wd-text-secondary">
                Автопродление для нового тарифа не настроено. Чтобы списания продолжались автоматически,
                оформите подписку ещё раз на странице{" "}
                <Link href="/pricing" className="font-bold text-wd-secondary hover:text-white">
                  тарифов
                </Link>
                .
              </p>
            )}
            <Link href="/pricing" className="inline-flex text-sm font-bold text-wd-secondary hover:text-white">
              Оплатить новый период
            </Link>
          </section>
        )}

        <section className="space-y-4">
          <h2 className="text-lg font-black uppercase tracking-wide text-white">Доступные тарифы</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {SUBSCRIPTION_PLANS.map((plan) => {
              const Icon = PLAN_ICONS[plan.id] ?? FaStar;
              const isCurrent = plan.id === currentPlanId;

              return (
                <article key={plan.id} className="wd-card flex flex-col gap-4 p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-wd bg-[#0A0A0A] text-wd-secondary">
                      <Icon />
                    </div>
                    <div>
                      <h3 className="text-base font-black text-white">{plan.name}</h3>
                      <p className="text-xs text-wd-text-secondary">
                        {plan.monthlyPrice === 0 ? "Бесплатно" : `${formatPrice(plan.monthlyPrice)} ₽ / мес`}
                      </p>
                    </div>
                  </div>
                  <ul className="space-y-1.5 text-xs text-wd-text-secondary">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <FaCheck className="mt-0.5 shrink-0 text-[10px] text-wd-primary" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <span className="rounded-wd-pill border border-wd-border px-4 py-2 text-center text-xs font-bold text-wd-text-secondary">
                      Текущий тариф
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSelectedPlan(plan)}
                      className="wd-button w-full py-2.5 text-sm"
                    >
                      Перейти
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </main>

      {selectedPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="wd-card w-full max-w-md space-y-4 p-6">
            <h2 className="text-lg font-black text-white">Перейти на тариф «{selectedPlan.name}»</h2>
            <p className="text-sm text-wd-text-secondary">
              Можно применить тариф сразу или дождаться окончания текущей подписки.
            </p>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={changing}
                onClick={() => handleChange("immediate")}
                className="wd-button w-full py-3 text-sm disabled:opacity-50"
              >
                Применить сейчас
              </button>
              <button
                type="button"
                disabled={changing || !canDefer}
                onClick={() => handleChange("afterExpiry")}
                className="w-full rounded-wd-pill border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm font-bold text-white transition-colors hover:border-wd-secondary disabled:opacity-50"
              >
                После окончания
              </button>
              <button
                type="button"
                disabled={changing}
                onClick={() => setSelectedPlan(null)}
                className="w-full py-2 text-sm font-medium text-wd-text-secondary hover:text-white"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
