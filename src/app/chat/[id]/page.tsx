"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaUser, FaCog, FaChevronDown, FaChevronUp, FaRedo, FaEllipsisH, FaRegCopy } from "react-icons/fa";
import MemoryEditor from "@/components/MemoryEditor";
import PersonaSelector from "@/components/PersonaSelector";
import type { ChatPersona } from "@/lib/persona";
import {
  calculateRequestCost,
  getEffectiveModelPriceVC,
  type EconomyModel,
  type EconomyUser,
} from "@/lib/verseChatEconomy";
import {
  ChatStreamRequestError,
  fetchAndReadChatStream,
  type ChatStreamMessage,
} from "@/lib/chatStream";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import { useTranslation } from "react-i18next";
import { pickLocalizedText } from "@/lib/characterFields";

const MODEL_DESCRIPTIONS: Record<string, string> = {
  "DeepSeek V4 Flash": "Самая быстрая модель для длинных динамичных переписок.",
  "Gemma 4 31B": "Лёгкий старт, приятный слог, отличный русский язык.",
  "Mistral Small 4": "Хороший баланс цены и качества, живые диалоги.",
  "Gemini 2.5 Flash": "Креативная, для нестандартных сюжетов и идей.",
  "Mistral Small 3.1 24B": "Хорошая модель для ролевых игр и сложных персонажей.",
  "Claude Haiku 4.5": "Надёжный стиль, сильное мышление, без «воды».",
  "Grok 4.20": "Максимальная реалистичность, минимум галлюцинаций.",
  "Gemini 2.5 Pro": "Глубокое понимание контекста, построение миров.",
  "Mistral Large 2": "Сложные рассуждения, профессиональные сценарии.",
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
  name_en?: string | null;
  greeting: string | null;
  greeting_en?: string | null;
  imageUrl: string | null;
  description: string | null;
  description_en?: string | null;
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

function asChatMessage(message: ChatStreamMessage): Message {
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    createdAt:
      typeof message.createdAt === "string"
        ? message.createdAt
        : new Date(message.createdAt).toISOString(),
  };
}

function isPersistedMessage(message: Message): boolean {
  return message.id !== "greeting" && !message.id.startsWith("temp-");
}

type MessageMenuProps = {
  message: Message;
  disabled: boolean;
  align: "left" | "right";
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
};

function MessageMenu({ message, disabled, align, onEdit, onDelete }: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (!isPersistedMessage(message)) {
    return null;
  }

  const menuItemClass =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-white transition-colors hover:bg-[#2A2A2A] disabled:opacity-40";

  const menuButtonClass =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40";

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={menuButtonClass}
        title="Действия"
        aria-label="Действия с сообщением"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <FaEllipsisH size={17} />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] py-1 shadow-xl ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEdit(message.id);
            }}
            disabled={disabled}
            className={menuItemClass}
          >
            <span aria-hidden>✏️</span>
            Редактировать
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete(message.id);
            }}
            disabled={disabled}
            className={menuItemClass}
          >
            <span aria-hidden>🗑️</span>
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}

type MessageToolbarProps = {
  message: Message;
  disabled: boolean;
  onRegenerate: (messageId: string) => void;
  onContinue: () => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onCopy: (content: string) => void;
};

function MessageToolbar({
  message,
  disabled,
  onRegenerate,
  onContinue,
  onDelete,
  onEdit,
  onCopy,
}: MessageToolbarProps) {
  if (!isPersistedMessage(message)) {
    return null;
  }

  const isUser = message.role === "user";
  const actionButtonClass =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40";
  const textButtonClass =
    "flex h-7 shrink-0 items-center rounded px-1 text-xs text-gray-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40";

  if (isUser) {
    return (
      <div className="flex shrink-0 flex-nowrap items-center gap-1">
        <MessageMenu
          message={message}
          disabled={disabled}
          align="left"
          onEdit={onEdit}
          onDelete={onDelete}
        />
        <button
          type="button"
          onClick={() => onCopy(message.content)}
          disabled={disabled}
          className={actionButtonClass}
          title="Копировать"
          aria-label="Копировать"
        >
          <FaRegCopy size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-1">
      <button
        type="button"
        onClick={onContinue}
        disabled={disabled}
        className={textButtonClass}
        title="Продолжить"
      >
        Продолжить
      </button>
      <button
        type="button"
        onClick={() => onRegenerate(message.id)}
        disabled={disabled}
        className={actionButtonClass}
        title="Перегенерировать"
        aria-label="Перегенерировать"
      >
        <FaRedo size={16} />
      </button>
      <button
        type="button"
        onClick={() => onCopy(message.content)}
        disabled={disabled}
        className={actionButtonClass}
        title="Копировать"
        aria-label="Копировать"
      >
        <FaRegCopy size={16} />
      </button>
      <MessageMenu
        message={message}
        disabled={disabled}
        align="right"
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function MessageAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className="h-6 w-6 shrink-0 rounded-full object-cover"
      />
    );
  }

  const initials = getInitials(name);
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#2A2A2A] text-[9px] font-semibold text-gray-300">
      {initials || <FaUser size={10} className="text-gray-400" />}
    </div>
  );
}

type ChatMessageItemProps = {
  message: Message;
  displayName: string;
  avatarUrl: string | null;
  isEditing: boolean;
  editingDraft: string;
  actionDisabled: boolean;
  isStreaming?: boolean;
  onEditDraftChange: (value: string) => void;
  onEditCancel: () => void;
  onEditSave: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onContinue: () => void;
  onDelete: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onCopy: (content: string) => void;
};

function ChatMessageItem({
  message,
  displayName,
  avatarUrl,
  isEditing,
  editingDraft,
  actionDisabled,
  isStreaming = false,
  onEditDraftChange,
  onEditCancel,
  onEditSave,
  onRegenerate,
  onContinue,
  onDelete,
  onEdit,
  onCopy,
}: ChatMessageItemProps) {
  const isUser = message.role === "user";

  const avatarBlock = (
    <div className={`flex shrink-0 min-w-0 items-center gap-1 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <MessageAvatar name={displayName} imageUrl={avatarUrl} />
      <span className="hidden truncate text-[11px] font-semibold text-gray-400 md:inline">{displayName}</span>
    </div>
  );

  const actionsBlock = !isEditing ? (
    <MessageToolbar
      message={message}
      disabled={actionDisabled}
      onRegenerate={onRegenerate}
      onContinue={onContinue}
      onDelete={onDelete}
      onEdit={onEdit}
      onCopy={onCopy}
    />
  ) : (
    <div className="h-7 w-7 shrink-0" aria-hidden />
  );

  return (
    <div
      className={`flex w-full max-w-[90%] flex-col gap-0.5 md:max-w-[85%] ${
        isUser ? "ml-auto items-end" : "items-start"
      }`}
    >
      <div className="flex w-full flex-nowrap items-center justify-between gap-1">
        {isUser ? (
          <>
            {actionsBlock}
            {avatarBlock}
          </>
        ) : (
          <>
            {avatarBlock}
            {actionsBlock}
          </>
        )}
      </div>

      {isEditing ? (
        <div
          className={`w-full min-w-[220px] rounded-lg border p-3 ${
            isUser
              ? "border-[#9C27B0]/70 bg-black/50 text-white backdrop-blur-sm"
              : "border-[#6C63FF]/40 bg-black/40 text-white backdrop-blur-sm"
          }`}
        >
          <textarea
            value={editingDraft}
            onChange={(e) => onEditDraftChange(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border border-divider bg-[#121212] px-3 py-2 text-sm text-white outline-none focus:border-primary/60"
            disabled={actionDisabled}
          />
          <div className={`mt-2 flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
            <button
              type="button"
              onClick={onEditCancel}
              disabled={actionDisabled}
              className="rounded-full px-3 py-1 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => onEditSave(message.id)}
              disabled={actionDisabled || !editingDraft.trim()}
              className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              Сохранить
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`w-full break-words rounded-lg border px-4 py-2 text-sm ${
            isUser
              ? "border-[#9C27B0]/70 bg-black/50 text-white backdrop-blur-sm"
              : "border-[#6C63FF]/40 bg-black/40 text-white backdrop-blur-sm"
          }`}
        >
          {isStreaming && !message.content ? (
            <span className="animate-pulse text-gray-400">Печатает...</span>
          ) : (
            <span
              dangerouslySetInnerHTML={{
                __html: formatMessageContent(message.content) + (isStreaming ? '<span class="animate-pulse">▍</span>' : ""),
              }}
            />
          )}
        </div>
      )}
    </div>
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
  onOpenMemory,
  onOpenPersona,
  onClearChat,
  disabled,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenModels: () => void;
  onOpenMemory: () => void;
  onOpenPersona: () => void;
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
              onOpenMemory();
            }}
            className="block w-full px-4 py-2.5 text-left text-sm text-white transition-colors hover:bg-[#2A2A2A]"
          >
            Редактировать память
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onOpenPersona();
            }}
            className="block w-full px-4 py-2.5 text-left text-sm text-white transition-colors hover:bg-[#2A2A2A]"
          >
            Моя личность
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
  wide?: boolean;
  children: React.ReactNode;
};

function Modal({ open, onClose, title, wide = false, children }: ModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/80 p-4 pt-16 backdrop-blur-sm md:items-center md:pt-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`relative mx-auto flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] shadow-xl ${
          wide ? "max-w-lg md:max-w-2xl" : "max-w-sm md:max-w-md"
        }`}
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
                  <div className="flex shrink-0 items-end">
                    <span className="text-sm text-gray-400">{priceLabel}</span>
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
  const { data: session, status } = useSession();
  const { i18n } = useTranslation();
  const locale = i18n.language;

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
  const [memoryEditorOpen, setMemoryEditorOpen] = useState(false);
  const [personaSelectorOpen, setPersonaSelectorOpen] = useState(false);
  const [selectedPersona, setSelectedPersona] = useState<ChatPersona | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
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

  const userDisplayName = selectedPersona?.name ?? session?.user?.name ?? session?.user?.email ?? "Вы";
  const userAvatarUrl = selectedPersona?.avatarUrl ?? session?.user?.image ?? null;
  const characterDisplayName =
    pickLocalizedText(character?.name, character?.name_en, locale) ?? "Персонаж";
  const characterDescription = pickLocalizedText(
    character?.description,
    character?.description_en,
    locale
  );
  const characterGreeting = pickLocalizedText(character?.greeting, character?.greeting_en, locale);
  const characterAvatarUrl = character?.imageUrl ?? null;

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
    setSelectedPersona(null);
    setLoading(true);

    const fetchData = async () => {
      try {
        const [chatRes, modelsRes, balanceRes, personaRes] = await Promise.all([
          axios.get<ChatHistoryResponse>(`/api/chat/${characterId}`),
          axios.get<ModelsResponse>("/api/models"),
          axios.get<BalanceData>("/api/user/balance"),
          axios.get<{ persona: ChatPersona | null }>(`/api/chat/${characterId}/persona`),
        ]);

        const { messages: loadedMessages, character: loadedCharacter } = chatRes.data;
        setCharacter(loadedCharacter);
        const greeting = pickLocalizedText(
          loadedCharacter.greeting,
          loadedCharacter.greeting_en,
          locale
        );

        if (loadedMessages.length === 0 && greeting) {
          setMessages([createGreetingMessage(greeting)]);
        } else {
          setMessages(loadedMessages);
        }
        setModels(modelsRes.data.models);
        setBaseModelId(modelsRes.data.baseModelId);
        setBalance(balanceRes.data);
        setSelectedPersona(personaRes.data.persona ?? null);

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

  useEffect(() => {
    const html = document.documentElement;
    const previousHtmlOverflow = html.style.overflow;
    const previousHtmlOverscroll = html.style.overscrollBehavior;
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    return () => {
      html.style.overflow = previousHtmlOverflow;
      html.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, []);

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
    if (error instanceof ChatStreamRequestError) {
      const statusCode = error.status;
      const message = error.payload.error || error.message;

      if (statusCode === 402) {
        toast.error(message || "Недостаточно VerseCoins");
      } else if (statusCode === 429) {
        toast.error(message || "Достигнут суточный лимит запросов");
      } else {
        toast.error(message || fallback);
      }
      return;
    }

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
    } else if (error instanceof Error && error.message) {
      toast.error(error.message);
    } else {
      toast.error(fallback);
    }
  };

  const handleRegenerate = async (messageId: string) => {
    if (sending || actionLoading || !ensureCanPerformPaidAction()) return;

    const original = messages.find((msg) => msg.id === messageId);
    if (!original) return;

    setActionLoading(true);
    setStreamingMessageId(messageId);
    setMessages((prev) =>
      prev.map((msg) => (msg.id === messageId ? { ...msg, content: "" } : msg))
    );

    try {
      const endEvent = await fetchAndReadChatStream(
        `/api/chat/${characterId}/regenerate`,
        { messageId },
        {
          onMeta: () => {
            setMessages((prev) =>
              prev.map((msg) => (msg.id === messageId ? { ...msg, content: "" } : msg))
            );
          },
          onDelta: (text) => {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId ? { ...msg, content: msg.content + text } : msg
              )
            );
          },
          onEnd: (event) => {
            updateBalanceFromResponse(event);
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId ? asChatMessage(event.assistantMessage) : msg
              )
            );
          },
        }
      );

      if (!endEvent) {
        setMessages((prev) =>
          prev.map((msg) => (msg.id === messageId ? original : msg))
        );
        toast.error("Поток ответа прервался");
        return;
      }

      toast.success("Ответ перегенерирован");
    } catch (error) {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === messageId ? original : msg))
      );
      handleApiError(error, "Не удалось перегенерировать ответ");
    } finally {
      setStreamingMessageId(null);
      setActionLoading(false);
    }
  };

  const handleContinue = async () => {
    if (sending || actionLoading || !ensureCanPerformPaidAction()) return;

    const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
    const originalContent = lastAssistant?.content ?? "";
    let targetId = lastAssistant?.id;
    let createdPlaceholder = false;

    setSending(true);
    try {
      const endEvent = await fetchAndReadChatStream(
        `/api/chat/${characterId}`,
        { continue: true },
        {
          onMeta: (event) => {
            if (event.appendToId) {
              targetId = event.appendToId;
              setStreamingMessageId(event.appendToId);
              return;
            }

            const streamingId = `temp-assistant-${Date.now()}`;
            targetId = streamingId;
            createdPlaceholder = true;
            setStreamingMessageId(streamingId);
            setMessages((prev) => [
              ...prev,
              {
                id: streamingId,
                role: "assistant",
                content: "",
                createdAt: new Date().toISOString(),
              },
            ]);
          },
          onDelta: (text) => {
            if (!targetId) return;
            const id = targetId;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === id ? { ...msg, content: msg.content + text } : msg
              )
            );
          },
          onEnd: (event) => {
            updateBalanceFromResponse(event);
            const saved = asChatMessage(event.assistantMessage);
            setMessages((prev) => {
              if (prev.some((msg) => msg.id === saved.id)) {
                return prev.map((msg) => (msg.id === saved.id ? saved : msg));
              }
              if (createdPlaceholder && targetId) {
                return prev.map((msg) => (msg.id === targetId ? saved : msg));
              }
              return [...prev, saved];
            });
          },
        }
      );

      if (!endEvent) {
        if (createdPlaceholder && targetId) {
          setMessages((prev) => prev.filter((msg) => msg.id !== targetId));
        } else if (lastAssistant) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === lastAssistant.id ? { ...msg, content: originalContent } : msg
            )
          );
        }
        toast.error("Поток ответа прервался");
        return;
      }

      toast.success("Ответ продолжен");
    } catch (error) {
      if (createdPlaceholder && targetId) {
        setMessages((prev) => prev.filter((msg) => msg.id !== targetId));
      } else if (lastAssistant) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === lastAssistant.id ? { ...msg, content: originalContent } : msg
          )
        );
      }
      handleApiError(error, "Не удалось продолжить ответ");
    } finally {
      setStreamingMessageId(null);
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
      const greeting = characterGreeting;
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

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    reachGoal(METRIKA_GOALS.sendMessage);

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
    const streamingAssistant: Message = {
      id: `temp-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser, streamingAssistant]);
    setStreamingMessageId(streamingAssistant.id);

    let persistedUser: Message | null = null;

    try {
      const endEvent = await fetchAndReadChatStream(
        `/api/chat/${characterId}`,
        { message: userMessage },
        {
          onMeta: (event) => {
            if (event.userMessage) {
              persistedUser = asChatMessage(event.userMessage);
            }
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === optimisticUser.id && event.userMessage) {
                  return asChatMessage(event.userMessage);
                }
                if (msg.id === "greeting" && event.greetingMessage) {
                  return asChatMessage(event.greetingMessage);
                }
                return msg;
              })
            );
          },
          onDelta: (text) => {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingAssistant.id
                  ? { ...msg, content: msg.content + text }
                  : msg
              )
            );
          },
          onEnd: (event) => {
            updateBalanceFromResponse(event);
            if (event.userMessage) {
              persistedUser = asChatMessage(event.userMessage);
            }
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === optimisticUser.id && event.userMessage) {
                  return asChatMessage(event.userMessage);
                }
                if (msg.id === "greeting" && event.greetingMessage) {
                  return asChatMessage(event.greetingMessage);
                }
                if (msg.id === streamingAssistant.id) {
                  return asChatMessage(event.assistantMessage);
                }
                return msg;
              })
            );
          },
        }
      );

      if (!endEvent) {
        setMessages((prev) => prev.filter((msg) => msg.id !== streamingAssistant.id));
        toast.error("Поток ответа прервался");
      }
    } catch (error) {
      setMessages((prev) => {
        const withoutAssistant = prev.filter((msg) => msg.id !== streamingAssistant.id);
        if (persistedUser) {
          return withoutAssistant.map((msg) =>
            msg.id === optimisticUser.id ? persistedUser! : msg
          );
        }
        return withoutAssistant.filter((msg) => msg.id !== optimisticUser.id);
      });

      if (!persistedUser) {
        setInput(userMessage);
      }
      handleApiError(error, "Не удалось отправить сообщение");
    } finally {
      setStreamingMessageId(null);
      setSending(false);
    }
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-bg-page text-primary-text md:h-[calc(100dvh-5rem)]">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-bg-page text-primary-text md:h-[calc(100dvh-5rem)]">
        <Toaster position="top-right" />
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center gap-4 overflow-y-auto">
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
      className={`relative flex h-[calc(100dvh-3.5rem)] max-h-[calc(100dvh-3.5rem)] min-h-0 max-w-full flex-col overflow-hidden overscroll-none text-primary-text md:h-[calc(100dvh-5rem)] md:max-h-[calc(100dvh-5rem)] ${
        character?.imageUrl ? "" : "bg-bg-page"
      }`}
      style={{
        backgroundImage: character?.imageUrl ? `url(${character.imageUrl})` : "none",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {character?.imageUrl && (
        <div className="pointer-events-none absolute inset-0 bg-black/60" aria-hidden />
      )}
      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        <Toaster position="top-right" />

        <Modal open={profileOpen} onClose={() => setProfileOpen(false)} title="Профиль персонажа">
          <div className="flex flex-col items-center gap-4 text-center">
            {character?.imageUrl ? (
              <img
                src={character.imageUrl}
                alt={characterDisplayName}
                className="h-24 w-24 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-transparent">
                <FaUser className="text-4xl text-white" />
              </div>
            )}
            <h3 className="text-lg font-semibold text-white">{characterDisplayName}</h3>
            <p className="text-left text-sm leading-relaxed text-secondary-text whitespace-pre-wrap">
              {characterDescription || "Описание не указано."}
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

        <Modal
          open={memoryEditorOpen}
          onClose={() => setMemoryEditorOpen(false)}
          title="Редактировать память"
          wide
        >
          <MemoryEditor
            characterId={characterId}
            onClose={() => setMemoryEditorOpen(false)}
          />
        </Modal>

        <Modal
          open={personaSelectorOpen}
          onClose={() => setPersonaSelectorOpen(false)}
          title="Моя личность"
          wide
        >
          <PersonaSelector
            characterId={characterId}
            selectedPersona={selectedPersona}
            onChange={setSelectedPersona}
          />
        </Modal>

        {/* Мобильная аватарка — только иконка, по клику профиль */}
        <button
          type="button"
          onClick={() => setProfileOpen(true)}
          className="fixed left-2 top-16 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/30 backdrop-blur-sm md:hidden"
          title={characterDisplayName}
          aria-label="Профиль персонажа"
        >
          {character?.imageUrl ? (
            <img
              src={character.imageUrl}
              alt={characterDisplayName}
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
              alt={characterDisplayName}
              className="h-12 w-12 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-transparent">
              <FaUser className="text-xl text-white" />
            </div>
          )}
          <span className="line-clamp-3 text-center text-base font-semibold text-white">
            {characterDisplayName}
          </span>
        </aside>

        {/* Настройки: мобиль — правый угол, десктоп — у баланса */}
        <aside className="fixed right-2 top-16 z-20 flex w-10 justify-center bg-transparent md:right-[120px] md:top-20 md:w-[60px]">
          <ChatSettingsMenu
            open={settingsMenuOpen}
            onToggle={() => setSettingsMenuOpen((current) => !current)}
            onClose={() => setSettingsMenuOpen(false)}
            onOpenModels={() => setSettingsOpen(true)}
            onOpenMemory={() => setMemoryEditorOpen(true)}
            onOpenPersona={() => setPersonaSelectorOpen(true)}
            onClearChat={handleClearChat}
            disabled={sending || actionLoading || clearingChat}
          />
        </aside>

        <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex w-full max-w-3xl flex-col space-y-2 px-4 pb-3 pt-12 md:space-y-4 md:px-4 md:pt-6">
            {messages.length === 0 ? (
              <div className="py-16 text-center text-sm text-secondary-text md:py-20">
                Начните диалог с персонажем. Напишите что-нибудь!
              </div>
            ) : (
              messages.map((msg) => (
                <ChatMessageItem
                  key={msg.id}
                  message={msg}
                  displayName={msg.role === "user" ? userDisplayName : characterDisplayName}
                  avatarUrl={msg.role === "user" ? userAvatarUrl : characterAvatarUrl}
                  isEditing={editingMessageId === msg.id}
                  editingDraft={editingDraft}
                  actionDisabled={sending || actionLoading || clearingChat}
                  isStreaming={streamingMessageId === msg.id}
                  onEditDraftChange={setEditingDraft}
                  onEditCancel={handleEditCancel}
                  onEditSave={handleEditSave}
                  onRegenerate={handleRegenerate}
                  onContinue={handleContinue}
                  onDelete={handleDelete}
                  onEdit={handleEditStart}
                  onCopy={handleCopy}
                />
              ))
            )}
            <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="shrink-0 border-t border-[#2A2A2A] bg-[#121212] px-3 py-3 md:p-4">
            <form
              onSubmit={sendMessage}
              className="chat-form mx-auto flex w-full max-w-3xl flex-col gap-2 sm:flex-row"
              data-metrika="chat-form"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Напишите сообщение..."
                className="min-h-[44px] w-full min-w-0 flex-1 rounded-full border border-divider bg-bg-card px-4 py-2.5 text-sm outline-none transition-colors focus:border-primary/60"
                disabled={sending || actionLoading || clearingChat}
              />
              <button
                type="submit"
                id="chat-send-btn"
                data-metrika="chat-send"
                disabled={!canSend}
                className="min-h-[44px] w-full shrink-0 rounded-full bg-primary px-6 py-2.5 text-sm font-bold text-white transition-all hover:bg-primary-hover active:scale-[0.98] disabled:bg-primary/50 sm:w-auto"
              >
                Отправить
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
