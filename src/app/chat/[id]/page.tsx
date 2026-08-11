"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaUser, FaCog } from "react-icons/fa";
import {
  calculateRequestCost,
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
  description: string | null;
};

type ChatHistoryResponse = {
  messages: Message[];
  character: ChatCharacter;
};

type ModelsResponse = {
  models: ChatModel[];
  selectedModelId: string | null;
  subscriptionActive: boolean;
  baseModelId: string | null;
};

function createGreetingMessage(content: string): Message {
  return {
    id: "greeting",
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };
}

function formatMessageContent(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(/\*(.*?)\*/g, '<span style="color: #B39DDB;">$1</span>').replace(/\n/g, "<br />");
}

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
};

function Modal({ open, onClose, title, children }: ModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-[#2A2A2A] bg-[#121212] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-modal-title"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="chat-modal-title" className="text-base font-black text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-secondary-text transition-colors hover:text-white"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    if (modelId === selectedModelId) return;

    const previousId = selectedModelId;
    setSelectedModelId(modelId);
    setChangingModel(true);
    try {
      await axios.post("/api/user/select-model", { modelId });
      toast.success("Модель изменена");
    } catch (err) {
      setSelectedModelId(previousId);
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

      if (typeof data.remainingVC === "number") {
        window.dispatchEvent(
          new CustomEvent("verseCoinsUpdated", { detail: { verseCoins: data.remainingVC } })
        );
      }

      setMessages((prev) =>
        prev.map((msg) => (msg.id === optimisticUser.id ? data.userMessage : msg))
      );

      setTimeout(() => {
        setMessages((prev) => [...prev, data.assistantMessage]);
        setSending(false);
      }, 1000);
    } catch (error) {
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticUser.id));

      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const message = error.response?.data?.error;

        if (statusCode === 402) {
          toast.error(message || "Недостаточно VerseCoins");
        } else if (statusCode === 429) {
          toast.error(message || "Достигнут суточный лимит запросов");
        } else if (statusCode === 403) {
          toast.error(message || "Модель доступна только по подписке");
        } else {
          toast.error(message || "Не удалось отправить сообщение");
        }
      } else {
        toast.error("Не удалось отправить сообщение");
      }
      setInput(userMessage);
      setSending(false);
    }
  };

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

        <Modal open={profileOpen} onClose={() => setProfileOpen(false)} title="Профиль персонажа">
          <div className="flex flex-col items-center gap-4 text-center">
            {character?.imageUrl ? (
              <img
                src={character.imageUrl}
                alt={character.name}
                className="h-28 w-28 rounded-full border-2 border-[#6C63FF]/50 object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-full border-2 border-[#6C63FF]/50 bg-[#1A1A1A]">
                <FaUser className="text-4xl text-[#6C63FF]" />
              </div>
            )}
            <h3 className="text-lg font-bold text-white">{character?.name}</h3>
            <p className="text-left text-sm leading-relaxed text-secondary-text whitespace-pre-wrap">
              {character?.description?.trim() || "Описание не указано."}
            </p>
          </div>
        </Modal>

        <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Настройки модели">
          <div className="space-y-2">
            {models.length === 0 ? (
              <p className="text-sm text-secondary-text">Модели не найдены</p>
            ) : (
              models.map((model) => (
                <label
                  key={model.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors ${
                    selectedModelId === model.id
                      ? "border-[#6C63FF] bg-[#6C63FF]/10"
                      : "border-[#2A2A2A] bg-[#0A0A0A] hover:border-[#6C63FF]/40"
                  } ${changingModel ? "pointer-events-none opacity-60" : ""}`}
                >
                  <input
                    type="radio"
                    name="chat-model"
                    value={model.id}
                    checked={selectedModelId === model.id}
                    onChange={() => handleModelChange(model.id)}
                    className="accent-[#6C63FF]"
                  />
                  <span className="flex-1 text-sm font-medium text-white">{model.displayName}</span>
                  {model.priceVC > 0 && (
                    <span className="text-xs text-secondary-text">{model.priceVC} VC</span>
                  )}
                </label>
              ))
            )}
          </div>
        </Modal>

        <main className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-2 pb-4 pt-16 sm:px-4 md:pb-6 md:pt-20">
          <div className="sticky top-0 z-10 -mx-2 border-b border-divider/40 bg-[#121212]/95 px-2 py-2 backdrop-blur-sm sm:-mx-4 sm:px-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="sr-only" htmlFor="chat-model-select">
                Модель
              </label>
              <select
                id="chat-model-select"
                value={selectedModelId}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={changingModel || models.length === 0}
                className="min-w-0 flex-1 rounded-full border border-divider bg-bg-card py-2 px-4 text-xs font-medium text-primary-text outline-none transition-colors focus:border-primary/60"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-divider bg-bg-card text-white transition-colors hover:border-[#6C63FF]/60 hover:text-[#6C63FF]"
                title="Профиль персонажа"
                aria-label="Профиль персонажа"
              >
                <FaUser size={14} />
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-divider bg-bg-card text-white transition-colors hover:border-[#6C63FF]/60 hover:text-[#6C63FF]"
                title="Настройки"
                aria-label="Настройки модели"
              >
                <FaCog size={14} />
              </button>
            </div>
          </div>

          <div className="min-h-[240px] flex-1 space-y-2 overflow-y-auto py-3 md:min-h-[300px] md:space-y-4 md:py-4">
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

          <form
            onSubmit={sendMessage}
            className="flex shrink-0 flex-col gap-2 border-t border-divider/40 pt-3 sm:flex-row md:pt-4"
          >
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
