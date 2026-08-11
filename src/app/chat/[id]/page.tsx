"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import {
  BASE_MODEL_COST_VC,
  calculateRequestCost,
  DAILY_REQUEST_LIMIT,
  normalizeUserCounters,
  type EconomyModel,
  type EconomyUser,
} from "@/lib/verseChatEconomy";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type ChatModel = EconomyModel & {
  pricePer1MInput: number | null;
  pricePer1MOutput: number | null;
};

type BalanceData = {
  verseCoins: number;
  subscriptionActive: boolean;
  freeRequestsRemaining: number | null;
  freeRequestsLimit: number;
  dailyRequests: number;
  dailyLimit: number;
  dailyRequestsRemaining: number;
  freeRequestsUsed: number;
  freeRequestsMonth: string;
  dailyRequestsDate: string;
  subscriptionType: string | null;
  subscriptionEnd: string | null;
};

type ChatCharacter = {
  name: string;
  greeting: string | null;
  imageUrl: string | null;
};

type ChatHistoryResponse = {
  messages: Message[];
  character: ChatCharacter;
};

function createGreetingMessage(content: string): Message {
  return {
    id: "greeting",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };
}
type ModelsResponse = {
  models: ChatModel[];
  selectedModelId: string | null;
  subscriptionActive: boolean;
  baseModelId: string | null;
};

function formatVc(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatMessageContent(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(/\*(.*?)\*/g, '<span style="color: #B39DDB;">$1</span>').replace(/\n/g, "<br />");
}

export default function ChatPage() {
  const params = useParams();
  const characterId = params.id as string;
  const { status } = useSession();

  const [messages, setMessages] = useState<Message[]>([]);
  const [character, setCharacter] = useState<ChatCharacter | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [baseModelId, setBaseModelId] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [changingModel, setChangingModel] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0] ?? null,
    [models, selectedModelId]
  );

  const baseModel = useMemo(
    () => models.find((model) => model.id === baseModelId) ?? models[0] ?? null,
    [models, baseModelId]
  );

  const costPreview = useMemo(() => {
    if (!selectedModel || !baseModel || !balance) return null;

    const economyUser: EconomyUser = {
      id: "",
      verseCoins: balance.verseCoins,
      subscriptionType: balance.subscriptionType,
      subscriptionEnd: balance.subscriptionEnd ? new Date(balance.subscriptionEnd) : null,
      freeRequestsUsed: balance.freeRequestsUsed,
      freeRequestsMonth: new Date(balance.freeRequestsMonth),
      dailyRequests: balance.dailyRequests,
      dailyRequestsDate: new Date(balance.dailyRequestsDate),
    };

    const counters = normalizeUserCounters(economyUser);
    return calculateRequestCost(economyUser, selectedModel, baseModel, counters);
  }, [selectedModel, baseModel, balance]);

  const requestCostVC = costPreview?.ok ? costPreview.costVC : 0;
  const insufficientBalance =
    Boolean(costPreview?.ok && requestCostVC > 0 && balance && balance.verseCoins < requestCostVC);
  const modelBlocked = costPreview?.ok === false;
  const canSend =
    !sending &&
    Boolean(input.trim()) &&
    !modelBlocked &&
    !insufficientBalance &&
    (balance?.dailyRequestsRemaining ?? 1) > 0;

  useEffect(() => {
    if (status === "unauthenticated") {
      setLoading(false);
      return;
    }

    if (!characterId || status !== "authenticated") {
      return;
    }

    setMessages([]);
    setCharacter(null);
    setLoading(true);

    const fetchData = async () => {
      try {
        const [chatRes, modelsRes, balanceRes] = await Promise.all([
          axios.get<ChatHistoryResponse>(`/api/chat/${characterId}`),
          axios.get<ModelsResponse>("/api/models"),
          axios.get<BalanceData>("/api/user/balance"),
        ]);

        const { messages: loadedMessages, character: loadedCharacter } = chatRes.data;
        setCharacter(loadedCharacter);
        const greeting = loadedCharacter.greeting?.trim();

        if (loadedMessages.length === 0 && greeting) {
          setMessages([createGreetingMessage(greeting)]);
        } else {
          setMessages(loadedMessages);
        }
        setModels(modelsRes.data.models);
        setBaseModelId(modelsRes.data.baseModelId);
        setBalance(balanceRes.data);

        const initialModelId =
          modelsRes.data.selectedModelId ?? modelsRes.data.models[0]?.id ?? "";
        setSelectedModelId(initialModelId);
      } catch {
        toast.error("Ошибка загрузки чата");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [characterId, status]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleModelChange = async (modelId: string) => {
    setSelectedModelId(modelId);
    setChangingModel(true);
    try {
      await axios.post("/api/user/select-model", { modelId });
      toast.success("Модель изменена");
    } catch (err) {
      toast.error(
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось выбрать модель"
      );
    } finally {
      setChangingModel(false);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    if (modelBlocked) {
      toast.error(costPreview && !costPreview.ok ? costPreview.error : "Модель недоступна");
      return;
    }

    if (insufficientBalance) {
      toast.error(`Недостаточно VC. Нужно ${requestCostVC}, на балансе ${balance?.verseCoins ?? 0}`);
      return;
    }

    if (balance && balance.dailyRequestsRemaining <= 0) {
      toast.error("Достигнут суточный лимит запросов");
      return;
    }

    const userMessage = input.trim();
    setInput("");
    setSending(true);

    const optimisticUser: Message = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    try {
      const { data } = await axios.post(`/api/chat/${characterId}`, {
        message: userMessage,
      });

      if (data.chargedVC > 0) {
        toast.success(`Списано ${data.chargedVC} VC`);
      }
      if (data.limitWarning) {
        toast(data.limitWarning, { icon: "⚠️" });
      }

      setBalance((prev) =>
        prev
          ? {
              ...prev,
              verseCoins: data.remainingVC ?? prev.verseCoins,
              dailyRequests: data.dailyRequests ?? prev.dailyRequests,
              dailyRequestsRemaining:
                data.dailyLimit !== undefined && data.dailyRequests !== undefined
                  ? Math.max(0, data.dailyLimit - data.dailyRequests)
                  : prev.dailyRequestsRemaining,
              freeRequestsUsed: data.freeRequestsUsed ?? prev.freeRequestsUsed,
              freeRequestsRemaining:
                data.freeRequestsRemaining !== undefined
                  ? data.freeRequestsRemaining
                  : prev.freeRequestsRemaining,
            }
          : prev
      );

      setMessages((prev) =>
        prev.map((msg) => (msg.id === optimisticUser.id ? data.userMessage : msg))
      );

      setTimeout(() => {
        setMessages((prev) => [...prev, data.assistantMessage]);
        setSending(false);
      }, 1000);
    } catch (error) {
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticUser.id));

      if (axios.isAxiosError(error) && error.response?.status === 402) {
        toast.error(error.response.data?.error || "Недостаточно средств");
      } else {
        toast.error(
          axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : "Не удалось отправить сообщение"
        );
      }
      setInput(userMessage);
      setSending(false);
    }
  };

  const dailyRemaining = balance?.dailyRequestsRemaining ?? DAILY_REQUEST_LIMIT;

  if (status === "loading" || loading) {
    return (
      <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
        <Toaster position="top-right" />
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center gap-4">
          <h1 className="text-xl font-black uppercase tracking-tight">Чат с персонажем</h1>
          <p className="text-xs text-secondary-text max-w-sm">
            Войдите в аккаунт, чтобы общаться с персонажами.
          </p>
          <a
            href="/login"
            className="bg-primary text-white px-6 py-2.5 rounded-full text-sm font-bold hover:bg-primary-hover transition-all"
          >
            Войти
          </a>
        </main>
      </div>
    );
  }

  return (
    <div
      className={`relative flex min-h-dvh flex-col text-primary-text ${
        character?.imageUrl ? "" : "bg-bg-page"
      }`}
      style={{
        backgroundImage: character?.imageUrl ? `url(${character.imageUrl})` : "none",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}
    >
      {character?.imageUrl && (
        <div className="pointer-events-none absolute inset-0 bg-black/60" aria-hidden />
      )}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <Toaster position="top-right" />
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-2 pb-4 pt-16 sm:px-4 md:pb-6 md:pt-20">
        <div className="mb-3 space-y-2 border-b border-divider/40 pb-3 md:mb-4 md:space-y-3 md:pb-4">
          <h1 className="text-lg font-black tracking-tight md:text-xl">Чат с персонажем</h1>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="text-xs font-bold text-secondary-text uppercase tracking-wider shrink-0">
              Модель
            </label>
            <select
              value={selectedModelId}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={changingModel || models.length === 0}
              className="flex-1 bg-bg-card border border-divider rounded-full py-2 px-4 text-xs outline-none focus:border-primary/60 transition-colors font-medium text-primary-text"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </div>

          {selectedModel && balance && (
            <div className="space-y-2 text-[11px] text-secondary-text">
              {costPreview?.ok === false ? (
                <p className="font-semibold text-red-400">{costPreview.error}</p>
              ) : requestCostVC === 0 ? (
                <p className="font-semibold text-[#6C63FF]">Этот запрос бесплатный</p>
              ) : (
                <p className="font-semibold text-white">
                  Этот запрос стоит {formatVc(requestCostVC)} VC
                </p>
              )}

              {insufficientBalance && (
                <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300">
                  Недостаточно VC: нужно {formatVc(requestCostVC)}, на балансе{" "}
                  {formatVc(balance.verseCoins)}.{" "}
                  <a href="/coins" className="underline hover:text-white">
                    Пополнить
                  </a>
                </p>
              )}

              {!balance.subscriptionActive && balance.freeRequestsRemaining !== null && (
                <p>
                  Бесплатных запросов в этом месяце:{" "}
                  <span className="font-bold text-white">{balance.freeRequestsRemaining}</span> из{" "}
                  {balance.freeRequestsLimit}
                </p>
              )}

              <p>
                Осталось{" "}
                <span className="font-bold text-white">{formatVc(dailyRemaining)}</span> запросов
                сегодня
              </p>

              <p className="text-[10px] text-secondary-text/80">
                Баланс: {formatVc(balance.verseCoins)} VC
                {selectedModel.priceVC > 0 && balance.subscriptionActive && selectedModel.id !== baseModelId
                  ? ` · модель: ${formatVc(selectedModel.priceVC)} VC/запрос`
                  : !balance.subscriptionActive && balance.freeRequestsRemaining === 0
                    ? ` · базовая модель: ${BASE_MODEL_COST_VC} VC/запрос`
                    : ""}
              </p>
            </div>
          )}
        </div>

        <div className="min-h-[240px] flex-1 space-y-2 overflow-y-auto pb-3 md:min-h-[300px] md:space-y-4 md:pb-4">
          {messages.length === 0 ? (
            <div className="text-center text-secondary-text text-sm py-20">
              Начните диалог с персонажем. Напишите что-нибудь!
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[88%] rounded-lg px-3 py-1.5 text-sm md:max-w-[75%] md:px-4 md:py-2 ${
                    msg.role === "user"
                      ? "bg-black border border-[#9C27B0]/70 text-white"
                      : "bg-[#1A1A1A] border border-[#6C63FF]/40 text-white"
                  }`}
                  dangerouslySetInnerHTML={{
                    __html: formatMessageContent(msg.content),
                  }}
                />
              </div>
            ))
          )}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-divider/40 bg-bg-card px-3 py-1.5 text-sm text-secondary-text md:px-4 md:py-2">
                <span className="animate-pulse">Печатает...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={sendMessage} className="flex flex-col gap-2 border-t border-divider/40 pt-3 sm:flex-row md:pt-4">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Напишите сообщение..."
            className="min-h-[44px] w-full flex-1 rounded-full border border-divider bg-bg-card px-4 py-2 text-sm outline-none transition-colors focus:border-primary/60"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={!canSend}
            className="min-h-[44px] w-full rounded-full bg-primary px-6 py-2 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50 sm:w-auto"
          >
            Отправить
          </button>
        </form>
        </main>
      </div>
    </div>
  );
}
