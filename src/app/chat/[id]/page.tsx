"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type ChatModel = {
  id: string;
  name: string;
  displayName: string;
  pricePer1MInput: number | null;
  pricePer1MOutput: number | null;
  isFreeForSubscribers: boolean;
};

type ChatHistoryResponse = {
  messages: Message[];
  character: {
    name: string;
    greeting: string | null;
  };
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
  isSubscribed: boolean;
};

function formatModelPrice(model: ChatModel): string {
  const input = model.pricePer1MInput ?? 0;
  const output = model.pricePer1MOutput ?? 0;
  return `${input}₽/1M ввод · ${output}₽/1M вывод`;
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
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? models[0] ?? null,
    [models, selectedModelId]
  );

  useEffect(() => {
    if (status === "unauthenticated") {
      setLoading(false);
      return;
    }

    if (!characterId || status !== "authenticated") {
      return;
    }

    setMessages([]);
    setLoading(true);

    const fetchData = async () => {
      try {
        const [chatRes, modelsRes] = await Promise.all([
          axios.get<ChatHistoryResponse>(`/api/chat/${characterId}`),
          axios.get<ModelsResponse>("/api/models"),
        ]);

        const { messages: loadedMessages, character } = chatRes.data;
        const greeting = character.greeting?.trim();

        if (loadedMessages.length === 0 && greeting) {
          setMessages([createGreetingMessage(greeting)]);
        } else {
          setMessages(loadedMessages);
        }
        setModels(modelsRes.data.models);
        setIsSubscribed(modelsRes.data.isSubscribed);

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

    const userMessage = input.trim();
    setInput("");
    setSending(true);

    try {
      const { data } = await axios.post(`/api/chat/${characterId}`, {
        message: userMessage,
      });
      setMessages((prev) => [...prev, data.userMessage, data.assistantMessage]);

      if (data.chargedCoins > 0) {
        toast.success(`Списано ${data.chargedCoins} RealCoins`);
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 402) {
        toast.error(error.response.data?.error || "Недостаточно средств");
      } else {
        toast.error(
          axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : "Ошибка отправки сообщения"
        );
      }
      setInput(userMessage);
    } finally {
      setSending(false);
    }
  };

  const modelIsFree =
    selectedModel && isSubscribed && selectedModel.isFreeForSubscribers;

  if (status === "loading" || loading) {
    return (
      <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
        <Footer />
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
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
      <Toaster position="top-right" />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-2 py-4 sm:px-4 md:py-6">
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

          {selectedModel && (
            <div className="text-[11px] text-secondary-text space-y-1">
              <p>{formatModelPrice(selectedModel)}</p>
              {selectedModel.isFreeForSubscribers ? (
                <p className="text-primary font-semibold">
                  {modelIsFree
                    ? "Бесплатно для подписчиков"
                    : "Бесплатно для подписчиков · сейчас платная модель"}
                </p>
              ) : (
                <p>Оплата списывается в RealCoins после каждого ответа</p>
              )}
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
                      ? "bg-primary text-white"
                      : "bg-[#1A1A1A] border border-[#6C63FF]/40 text-white"
                  }`}
                  {...(msg.role === "assistant"
                    ? {
                        dangerouslySetInnerHTML: {
                          __html: formatMessageContent(msg.content),
                        },
                      }
                    : { children: msg.content })}
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
            disabled={sending || !input.trim()}
            className="min-h-[44px] w-full rounded-full bg-primary px-6 py-2 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50 sm:w-auto"
          >
            Отправить
          </button>
        </form>
      </main>
      <Footer />
    </div>
  );
}
