"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaUser, FaCog, FaChevronDown, FaChevronUp, FaRedo, FaTrash, FaPen } from "react-icons/fa";
import {
  calculateRequestCost,
  getEffectiveModelPriceVC,
  type EconomyModel,
  type EconomyUser,
} from "@/lib/verseChatEconomy";

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "Gemma 4 31B": "Базовая модель с малым контекстом 4K. Экономный выбор для простых диалогов.",
  "DeepSeek V4 Flash": "Быстрая модель для динамичных историй. Контекст 6K.",
  "Minimax M2.7": "Сбалансированная модель для ролевых игр.",
  "Mistral Medium 3.1": "Глубокий контекст 8K, хорошее понимание диалогов.",
  "Gemini 3 Flash": "Мощная модель с контекстом 8K, отличная для сложных сюжетов.",
  "GLM 5": "Китайская модель, сильная логика и контекст 8K.",
  "GLM 5.1": "Улучшенная версия GLM, контекст 8K.",
  "Grok 4.20": "12K контекста, мощная модель для экспертных задач.",
  "Claude Haiku 4.5": "12K контекста, максимальная логика и качество ответов.",
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type ChatModel = EconomyModel & {
  pricePer1MInput: number | null;
  pricePer1MOutput: number | null;
  description: string | null;
};

type BalanceData = {
  verseCoins: number;
  subscriptionActive: boolean;
  dailyRequests: number;
  dailyLimit: number;
  dailyRequestsRemaining: number;
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

function isPersistedMessage(message: Message): boolean {
  return message.id !== "greeting" && !message.id.startsWith("temp-");
}

type MessageActionsProps = {
  message: Message;
  isLastAssistant: boolean;
  disabled: boolean;
  onRegenerate: (messageId: string) => void;
  onContinue: () => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string) => void;
};

function MessageActions({
  message,
  isLastAssistant,
  disabled,
  onRegenerate,
  onContinue,
  onDelete,
  onEdit,
}: MessageActionsProps) {
  if (!isPersistedMessage(message)) {
    return null;
  }

  const actionButtonClass =
    "rounded px-1.5 py-0.5 text-xs text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-300 disabled:opacity-40";

  if (message.role === "assistant") {
    return (
      <>
        {isLastAssistant && (
          <button
            type="button"
            onClick={onContinue}
            disabled={disabled}
            className={`${actionButtonClass} px-2`}
            title="Продолжить"
          >
            Продолжить
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(message.id)}
          disabled={disabled}
          className={actionButtonClass}
          title="Редактировать"
          aria-label="Редактировать"
        >
          <FaPen size={11} />
        </button>
        <button
          type="button"
          onClick={() => onRegenerate(message.id)}
          disabled={disabled}
          className={actionButtonClass}
          title="Перегенерировать"
          aria-label="Перегенерировать"
        >
          <FaRedo size={11} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          disabled={disabled}
          className={actionButtonClass}
          title="Удалить"
          aria-label="Удалить"
        >
          <FaTrash size={11} />
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => onEdit(message.id)}
        disabled={disabled}
        className={actionButtonClass}
        title="Редактировать"
        aria-label="Редактировать"
      >
        <FaPen size={11} />
      </button>
      <button
        type="button"
        onClick={() => onDelete(message.id)}
        disabled={disabled}
        className={actionButtonClass}
        title="Удалить"
        aria-label="Удалить"
      >
        <FaTrash size={11} />
      </button>
    </>
  );
}

function formatMessageContent(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(/\*(.*?)\*/g, '<span style="color: #B39DDB;">$1</span>').replace(/\n/g, "<br />");
}

function ChatSettingsMenu({
  open,
  onToggle,
  onClose,
  onOpenModels,
  onClearChat,
  disabled,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenModels: () => void;
  onClearChat: () => void;
  disabled: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm transition-colors hover:text-[#6C63FF] disabled:opacity-50 md:bg-transparent md:backdrop-blur-none"
        title="Настройки чата"
        aria-label="Настройки чата"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <FaCog size={18} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 min-w-[180px] overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] py-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onOpenModels();
            }}
            className="block w-full px-4 py-2.5 text-left text-sm text-white transition-colors hover:bg-[#2A2A2A]"
          >
            Модели чата
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onClearChat();
            }}
            disabled={disabled}
            className="block w-full px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-[#2A2A2A] disabled:opacity-50"
          >
            Очистить чат
          </button>
        </div>
      )}
    </div>
  );
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
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/80 p-4 pt-16 backdrop-blur-sm md:items-center md:pt-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="relative mx-auto flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] shadow-xl md:max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-modal-title"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-2xl leading-none text-white transition-colors hover:bg-black/70 active:scale-95"
          aria-label="Закрыть"
        >
          ✕
        </button>

        <div className="shrink-0 border-b border-[#2A2A2A] p-4 pr-16 md:p-6 md:pr-20">
          <h2 id="chat-modal-title" className="text-base font-black text-white md:text-lg">
            {title}
          </h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}

type ModelSettingsListProps = {
  models: ChatModel[];
  selectedModelId: string;
  baseModel: ChatModel | null;
  balance: BalanceData | null;
  changingModel: boolean;
  onModelChange: (modelId: string) => void;
};

function ModelSettingsList({
  models,
  selectedModelId,
  baseModel,
  balance,
  changingModel,
  onModelChange,
}: ModelSettingsListProps) {
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);

  const toggleDescription = (modelId: string) => {
    setExpandedModelId((current) => (current === modelId ? null : modelId));
  };

  return (
    <>
      {models.map((model) => {
        const isExpanded = expandedModelId === model.id;
        const description = model.description ?? MODEL_DESCRIPTIONS[model.displayName];
        const priceLabel =
          balance && baseModel
            ? `${getEffectiveModelPriceVC(
                {
                  subscriptionType: balance.subscriptionType,
                  subscriptionEnd: balance.subscriptionEnd
                    ? new Date(balance.subscriptionEnd)
                    : null,
                },
                model,
                baseModel
              )} VC/запрос`
            : `${model.priceVC} VC/запрос`;

        return (
          <div key={model.id} className="group border-b border-gray-700/50 last:border-b-0">
            <label
              className={`flex cursor-pointer items-center justify-between px-4 py-3 transition-colors md:px-6 ${
                selectedModelId === model.id ? "bg-[#6C63FF]/10" : "hover:bg-[#0A0A0A]"
              } ${changingModel ? "pointer-events-none opacity-60" : ""}`}
              title={description}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <input
                  type="radio"
                  name="chat-model"
                  value={model.id}
                  checked={selectedModelId === model.id}
                  onChange={() => onModelChange(model.id)}
                  className="shrink-0 accent-[#6C63FF]"
                />
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate text-base font-bold text-white md:text-lg">
                    {model.displayName}
                  </span>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-sm text-gray-400">{priceLabel}</span>
                    <span className="text-xs text-gray-500">
                      {model.maxContextTokens / 1000}K токенов
                    </span>
                  </div>
                </div>
              </div>

              {description && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleDescription(model.id);
                  }}
                  className="ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-[#0A0A0A] hover:text-white md:hidden"
                  aria-label={isExpanded ? "Скрыть описание" : "Показать описание"}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? <FaChevronUp size={14} /> : <FaChevronDown size={14} />}
                </button>
              )}
            </label>

            {description && isExpanded && (
              <p className="px-4 pb-3 pl-11 text-xs leading-relaxed text-gray-500 md:hidden">
                {description}
              </p>
            )}

            {description && (
              <p className="hidden px-4 pb-3 pl-11 text-xs leading-relaxed text-gray-500 md:block md:max-h-0 md:overflow-hidden md:pb-0 md:opacity-0 md:transition-all md:duration-200 md:group-hover:max-h-24 md:group-hover:pb-3 md:group-hover:opacity-100">
                {description}
              </p>
            )}
          </div>
        );
      })}
    </>
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && isPersistedMessage(messages[i])) {
        return messages[i].id;
      }
    }
    return null;
  }, [messages]);

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
      dailyRequests: balance.dailyRequests,
      dailyRequestsDate: new Date(balance.dailyRequestsDate),
    };

    return calculateRequestCost(economyUser, selectedModel, baseModel);
  }, [selectedModel, baseModel, balance]);

  const requestCostVC = costPreview?.ok ? costPreview.costVC : 0;
  const insufficientBalance =
    Boolean(costPreview?.ok && requestCostVC > 0 && balance && balance.verseCoins < requestCostVC);
  const canSend =
    !sending &&
    !actionLoading &&
    !clearingChat &&
    Boolean(input.trim()) &&
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

  const updateBalanceFromResponse = (data: {
    remainingVC?: number;
    dailyRequests?: number;
    dailyLimit?: number;
  }) => {
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
          }
        : prev
    );

    if (typeof data.remainingVC === "number") {
      window.dispatchEvent(
        new CustomEvent("verseCoinsUpdated", { detail: { verseCoins: data.remainingVC } })
      );
    }
  };

  const ensureCanPerformPaidAction = (): boolean => {
    if (insufficientBalance) {
      toast.error(`Недостаточно VC. Нужно ${requestCostVC}, на балансе ${balance?.verseCoins ?? 0}`);
      return false;
    }

    if (balance && balance.dailyRequestsRemaining <= 0) {
      toast.error("Достигнут суточный лимит запросов");
      return false;
    }

    return true;
  };

  const handleApiError = (error: unknown, fallback: string) => {
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const message = error.response?.data?.error;

      if (statusCode === 402) {
        toast.error(message || "Недостаточно VerseCoins");
      } else if (statusCode === 429) {
        toast.error(message || "Достигнут суточный лимит запросов");
      } else {
        toast.error(message || fallback);
      }
    } else {
      toast.error(fallback);
    }
  };

  const handleRegenerate = async (messageId: string) => {
    if (sending || actionLoading || !ensureCanPerformPaidAction()) return;

    setActionLoading(true);
    try {
      const { data } = await axios.post(`/api/chat/${characterId}/regenerate`, { messageId });
      updateBalanceFromResponse(data);
      setMessages((prev) =>
        prev.map((msg) => (msg.id === messageId ? data.assistantMessage : msg))
      );
      toast.success("Ответ перегенерирован");
    } catch (error) {
      handleApiError(error, "Не удалось перегенерировать ответ");
    } finally {
      setActionLoading(false);
    }
  };

  const handleContinue = async () => {
    if (sending || actionLoading || !ensureCanPerformPaidAction()) return;

    setSending(true);
    try {
      const { data } = await axios.post(`/api/chat/${characterId}`, { continue: true });
      updateBalanceFromResponse(data);
      setMessages((prev) => [...prev, data.assistantMessage]);
      toast.success("Ответ продолжен");
    } catch (error) {
      handleApiError(error, "Не удалось продолжить ответ");
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (messageId: string) => {
    if (sending || actionLoading) return;
    if (!window.confirm("Удалить это сообщение?")) return;

    setActionLoading(true);
    try {
      await axios.delete(`/api/messages/${messageId}`);
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
      if (editingMessageId === messageId) {
        setEditingMessageId(null);
        setEditingDraft("");
      }
      toast.success("Сообщение удалено");
    } catch (error) {
      handleApiError(error, "Не удалось удалить сообщение");
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditStart = (messageId: string) => {
    const message = messages.find((msg) => msg.id === messageId);
    if (!message) return;
    setEditingMessageId(messageId);
    setEditingDraft(message.content);
  };

  const handleEditCancel = () => {
    setEditingMessageId(null);
    setEditingDraft("");
  };

  const handleEditSave = async (messageId: string) => {
    const trimmed = editingDraft.trim();
    if (!trimmed) {
      toast.error("Сообщение не может быть пустым");
      return;
    }

    setActionLoading(true);
    try {
      const { data } = await axios.put<Message>(`/api/messages/${messageId}`, {
        content: trimmed,
      });
      setMessages((prev) => prev.map((msg) => (msg.id === messageId ? data : msg)));
      setEditingMessageId(null);
      setEditingDraft("");
      toast.success("Сообщение обновлено");
    } catch (error) {
      handleApiError(error, "Не удалось сохранить сообщение");
    } finally {
      setActionLoading(false);
    }
  };

  const handleClearChat = async () => {
    if (sending || actionLoading || clearingChat) return;
    if (!window.confirm("Очистить всю историю чата с этим персонажем?")) return;

    setClearingChat(true);
    try {
      await axios.delete(`/api/chat/${characterId}/messages`);
      const greeting = character?.greeting?.trim();
      setMessages(greeting ? [createGreetingMessage(greeting)] : []);
      setEditingMessageId(null);
      setEditingDraft("");
      setSettingsMenuOpen(false);
      toast.success("История чата очищена");
    } catch (error) {
      handleApiError(error, "Не удалось очистить чат");
    } finally {
      setClearingChat(false);
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

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

      updateBalanceFromResponse(data);

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
      className={`relative flex min-h-dvh max-w-full flex-col overflow-x-hidden text-primary-text ${
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
      <div className="relative z-10 flex min-h-0 max-w-full flex-1 flex-col overflow-x-hidden">
        <Toaster position="top-right" />

        <Modal open={profileOpen} onClose={() => setProfileOpen(false)} title="Профиль персонажа">
          <div className="flex flex-col items-center gap-4 text-center">
            {character?.imageUrl ? (
              <img
                src={character.imageUrl}
                alt={character.name}
                className="h-24 w-24 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-transparent">
                <FaUser className="text-4xl text-white" />
              </div>
            )}
            <h3 className="text-lg font-semibold text-white">{character?.name ?? "Персонаж"}</h3>
            <p className="text-left text-sm leading-relaxed text-secondary-text whitespace-pre-wrap">
              {character?.description?.trim() || "Описание не указано."}
            </p>
          </div>
        </Modal>

        <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Модели чата">
          <div className="-mx-4 -mb-4 md:-mx-6 md:-mb-6">
            {models.length === 0 ? (
              <p className="px-4 text-sm text-secondary-text md:px-6">Модели не найдены</p>
            ) : (
              <ModelSettingsList
                models={models}
                selectedModelId={selectedModelId}
                baseModel={baseModel}
                balance={balance}
                changingModel={changingModel}
                onModelChange={handleModelChange}
              />
            )}
          </div>
        </Modal>

        {/* Мобильная аватарка — только иконка, по клику профиль */}
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className="fixed left-2 top-16 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm md:hidden"
          title={character?.name ?? "Профиль персонажа"}
          aria-label="Профиль персонажа"
        >
          {character?.imageUrl ? (
            <img
              src={character.imageUrl}
              alt={character.name}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <FaUser className="text-lg text-white" />
          )}
        </button>

        {/* Десктоп: аватар + имя */}
        <aside className="fixed left-[100px] top-16 z-10 hidden w-[200px] flex-col items-center gap-2 bg-transparent px-3 py-4 backdrop-blur-sm md:top-20 md:flex">
          {character?.imageUrl ? (
            <img
              src={character.imageUrl}
              alt={character.name}
              className="h-12 w-12 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-transparent">
              <FaUser className="text-xl text-white" />
            </div>
          )}
          <span className="line-clamp-3 text-center text-base font-semibold text-white">
            {character?.name ?? "Персонаж"}
          </span>
        </aside>

        {/* Настройки: мобиль — правый угол, десктоп — у баланса */}
        <aside className="fixed right-2 top-16 z-20 flex w-10 justify-center bg-transparent md:right-[120px] md:top-20 md:w-[60px]">
          <ChatSettingsMenu
            open={settingsMenuOpen}
            onToggle={() => setSettingsMenuOpen((current) => !current)}
            onClose={() => setSettingsMenuOpen(false)}
            onOpenModels={() => setSettingsOpen(true)}
            onClearChat={handleClearChat}
            disabled={sending || actionLoading || clearingChat}
          />
        </aside>

        <main className="flex min-h-0 w-full max-w-full flex-1 flex-col overflow-x-hidden px-2 pb-2 pt-[4.5rem] md:px-0 md:pb-6 md:pl-48 md:pr-16 md:pt-20">
          <div className="mx-auto flex min-h-[240px] w-full max-w-full flex-1 flex-col space-y-2 overflow-y-auto overflow-x-hidden px-2 py-4 md:max-w-3xl md:space-y-4 md:px-4 md:py-6">
            {messages.length === 0 ? (
              <div className="py-16 text-center text-sm text-secondary-text md:py-20">
                Начните диалог с персонажем. Напишите что-нибудь!
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div className="relative max-w-[85%] md:max-w-[75%]">
                    {editingMessageId === msg.id ? (
                      <div
                        className={`w-full min-w-[220px] rounded-lg border p-3 ${
                          msg.role === "user"
                            ? "border-[#9C27B0]/70 bg-black"
                            : "border-[#6C63FF]/40 bg-[#1A1A1A]"
                        }`}
                      >
                        <textarea
                          value={editingDraft}
                          onChange={(e) => setEditingDraft(e.target.value)}
                          rows={3}
                          className="w-full resize-y rounded-md border border-divider bg-[#121212] px-3 py-2 text-sm text-white outline-none focus:border-primary/60"
                          disabled={actionLoading}
                        />
                        <div
                          className={`mt-2 flex gap-2 ${
                            msg.role === "user" ? "justify-end" : "justify-start"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={handleEditCancel}
                            disabled={actionLoading}
                            className="rounded-full px-3 py-1 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50"
                          >
                            Отмена
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEditSave(msg.id)}
                            disabled={actionLoading || !editingDraft.trim()}
                            className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
                          >
                            Сохранить
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`relative overflow-hidden rounded-lg border ${
                          msg.role === "user"
                            ? "border-[#9C27B0]/70 bg-black text-white"
                            : "border-[#6C63FF]/40 bg-[#1A1A1A] text-white"
                        }`}
                      >
                        <div
                          className={`absolute top-1 z-10 flex flex-row flex-wrap items-center gap-1 ${
                            msg.role === "user" ? "left-1" : "right-1"
                          }`}
                        >
                          <MessageActions
                            message={msg}
                            isLastAssistant={msg.id === lastAssistantMessageId}
                            disabled={sending || actionLoading || clearingChat}
                            onRegenerate={handleRegenerate}
                            onContinue={handleContinue}
                            onDelete={handleDelete}
                            onEdit={handleEditStart}
                          />
                        </div>
                        <div
                          className="break-words px-3 pb-3 pt-8 text-sm md:px-4"
                          dangerouslySetInnerHTML={{
                            __html: formatMessageContent(msg.content),
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-divider/40 bg-bg-card px-3 py-2 text-sm text-secondary-text md:px-4">
                  <span className="animate-pulse">Печатает...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={sendMessage}
            className="sticky bottom-0 z-10 mx-auto flex w-full max-w-full shrink-0 flex-col gap-2 border-t border-divider/40 bg-[#121212]/85 px-2 py-3 backdrop-blur-sm sm:flex-row md:max-w-3xl md:bg-transparent md:px-4 md:py-4 md:backdrop-blur-none"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Напишите сообщение..."
              className="min-h-[44px] w-full min-w-0 flex-1 rounded-full border border-divider bg-bg-card px-4 py-2 text-sm outline-none transition-colors focus:border-primary/60"
              disabled={sending || actionLoading || clearingChat}
            />
            <button
              type="submit"
              disabled={!canSend}
              className="min-h-[44px] w-full shrink-0 rounded-full bg-primary px-6 py-2 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50 sm:w-auto"
            >
              Отправить
            </button>
          </form>
        </main>
      </div>
    </div>
  );
}
