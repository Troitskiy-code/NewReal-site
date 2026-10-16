"use client";


import { useEffect, useState } from "react";
import type { IconType } from "react-icons";
import axios from "axios";
import { Trans } from "react-i18next";
import { useSession } from "next-auth/react";
import { showError } from "@/lib/toast";
import LocaleLink from "@/components/LocaleLink";
import ModerationWarning from "@/components/ModerationWarning";
import {
  FaChevronDown,
  FaCog,
  FaImage,
  FaBook,
  FaMagic,
  FaSpinner,
  FaTags,
} from "react-icons/fa";
import { CHARACTER_LIMITS } from "@/lib/characterFields";
import { MEMORY_CONTENT_LIMIT } from "@/lib/persistentMemory";
import { ensureReferenceImageDataUrl, ensureReferenceImageFile } from "@/lib/convertAvifToPng";
import { useAvatarGeneration } from "@/lib/useAvatarGeneration";
import CharacterTagPicker from "@/components/CharacterTagPicker";
import RoleplayPromptSettings from "@/components/RoleplayPromptSettings";
import RoleplayCardFields from "@/components/RoleplayCardFields";
import { useTelegramMode } from "@/components/TelegramProvider";
import type { RoleplayConfig, RoleplayMode, RoleplayStyle } from "@/lib/roleplayConfig";

const ICON_CLASS = "mr-2 shrink-0 text-[18px] text-gray-400";
const HINT_CLASS = "text-sm text-gray-400 leading-relaxed";
const INPUT_CLASS =
  "w-full rounded-lg border border-[#2a2638] bg-[#0c0b12] p-3 text-base text-white outline-none transition-colors placeholder:text-gray-400 focus:border-wd-secondary";

type FormBlockProps = {
  title: string;
  icon?: IconType;
  hints?: string[];
  children: React.ReactNode;
  className?: string;
};

function FieldTitle({ icon: Icon, title }: { icon?: IconType; title: string }) {
  return (
    <h2 className="flex items-center text-base font-bold text-white md:text-lg">
      {Icon && <Icon className={ICON_CLASS} aria-hidden />}
      {title}
    </h2>
  );
}

function FormBlock({ title, icon, hints, children, className = "" }: FormBlockProps) {
  return (
    <section className={`space-y-3 ${className}`}>
      <FieldTitle icon={icon} title={title} />
      {children}
      {hints?.map((hint) => (
        <p key={hint} className={HINT_CLASS}>
          {hint}
        </p>
      ))}
    </section>
  );
}

type LimitedTextareaProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
};

function LimitedTextarea({ id, value, onChange, maxLength, rows = 4, placeholder }: LimitedTextareaProps) {
  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) =>
        onChange(maxLength !== undefined ? e.target.value.slice(0, maxLength) : e.target.value)
      }
      placeholder={placeholder}
      rows={rows}
      maxLength={maxLength}
      className={`${INPUT_CLASS} resize-none leading-relaxed`}
    />
  );
}

function hintWithCounter(text: string, value: string, maxLength: number): string {
  return `${text} ${value.length}/${maxLength}`;
}

type ImageUploadProps = {
  preview: string | null;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  footerHint?: string;
  error?: string;
};

function ImageUploadField({ preview, onChange, onRemove, footerHint, error }: ImageUploadProps) {
  return (
    <div className="space-y-3">
      <div
        className={`relative flex min-h-[160px] flex-col items-center justify-center rounded-lg border-2 border-dashed bg-[#0c0b12] p-6 transition-colors hover:border-wd-secondary/50 ${
          error ? "border-red-500" : "border-gray-500"
        }`}
      >
        {preview ? (
          <div className="group relative h-full min-h-[120px] w-full max-w-xs">
            <img src={preview} alt="Превью" className="mx-auto h-full max-h-48 w-full rounded-lg object-contain" />
            <button
              type="button"
              onClick={onRemove}
              className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 text-sm font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              Удалить
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center gap-3 text-sm font-medium text-gray-400 transition-colors hover:text-white">
            <FaImage className="text-2xl text-gray-400" />
            <span>Загрузить изображение</span>
            <input type="file" accept="image/*" onChange={onChange} className="hidden" />
          </label>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {footerHint && <p className={HINT_CLASS}>{footerHint}</p>}
    </div>
  );
}

type VisibilityToggleProps = {
  isPublic: boolean;
  onChange: (isPublic: boolean) => void;
};

function VisibilityToggle({ isPublic, onChange }: VisibilityToggleProps) {
  const base = "flex-1 rounded-lg border px-6 py-3 text-base font-bold transition-colors";
  const active = "border-wd-secondary bg-wd-secondary text-wd-on-secondary";
  const inactive = "border-gray-500 bg-transparent text-gray-400 hover:border-gray-400 hover:text-gray-300";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`${base} w-full sm:flex-1 ${isPublic ? active : inactive}`}
      >
        Публичный
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`${base} w-full sm:flex-1 ${!isPublic ? active : inactive}`}
      >
        Личный
      </button>
    </div>
  );
}

export type CharacterFormValues = {
  name: string;
  appearance: string;
  description: string;
  greeting: string;
  scenario: string;
  exampleDialogs: string;
  descriptionCard: string;
  tags: string;
  avatarPrompt: string;
  /** Set from the avatar style the owner generated with; "" while unknown. */
  artStyle: "" | "anime" | "realistic";
  roleplayMode: RoleplayMode;
  roleplayStyle: RoleplayStyle;
  rpConfig: RoleplayConfig;
  isPublic: boolean;
  publicMemory: string;
  privateMemory: string;
};

export const EMPTY_CHARACTER_FORM: CharacterFormValues = {
  name: "",
  appearance: "",
  description: "",
  greeting: "",
  scenario: "",
  exampleDialogs: "",
  descriptionCard: "",
  tags: "",
  avatarPrompt: "",
  artStyle: "",
  roleplayMode: "character",
  roleplayStyle: "mixed",
  rpConfig: {},
  isPublic: false,
  publicMemory: "",
  privateMemory: "",
};

type CharacterFormProps = {
  characterId?: string;
  showModePicker?: boolean;
  values: CharacterFormValues;
  onChange: <K extends keyof CharacterFormValues>(field: K, value: CharacterFormValues[K]) => void;
  avatarPreview: string | null;
  onAvatarChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAvatarRemove: () => void;
  onAvatarGenerated: (imageUrl: string) => void;
  loraPreview: string | null;
  loraFile?: File | null;
  onLoraChange: (file: File) => void;
  onLoraRemove: () => void;
  errors?: {
    name?: string;
    avatar?: string;
    lora?: string;
  };
  onClearError?: (field: "name" | "avatar" | "lora") => void;
  moderationStatus?: string | null;
  moderationReason?: string | null;
};

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(file);
  });
}

const REFERENCE_MAX_SIDE = 2048;

/**
 * Phone photos are often 24–50 MP; the server only needs ~1.5K px, so shrink large ones before upload.
 * Falls back to the original file when the browser cannot decode or re-encode it.
 */
async function fileToReferenceDataUrl(file: File): Promise<string> {
  if (file.type === "image/gif" || typeof createImageBitmap !== "function") return fileToDataUrl(file);
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, REFERENCE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 2 * 1024 * 1024) {
      bitmap.close();
      return fileToDataUrl(file);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // Browsers without WebP encoding return PNG, which the server also accepts.
    const dataUrl = canvas.toDataURL("image/webp", 0.9);
    return /^data:image\/(webp|png);base64,/.test(dataUrl) ? dataUrl : fileToDataUrl(file);
  } catch {
    return fileToDataUrl(file);
  }
}

async function resolveReferenceImage(preview: string | null, file?: File | null): Promise<string | null> {
  if (file) return fileToReferenceDataUrl(file);
  if (preview && (preview.startsWith("data:") || preview.startsWith("http") || preview.startsWith("blob:"))) {
    return ensureReferenceImageDataUrl(preview);
  }
  return null;
}

type AvatarLimitStatus = {
  tokensUsedThisMonth: number;
  monthlyLimit: number;
  monthlyRemaining: number;
};

export default function CharacterForm(props: CharacterFormProps) {
  const { data: session } = useSession();
  return <CharacterFormContent key={`${session?.user?.id ?? "guest"}:${props.characterId ?? props.values.roleplayMode}`} {...props} />;
}

function CharacterFormContent({
  characterId,
  showModePicker = true,
  values,
  onChange,
  avatarPreview,
  onAvatarChange,
  onAvatarRemove,
  onAvatarGenerated,
  loraPreview,
  loraFile,
  onLoraChange,
  onLoraRemove,
  errors,
  onClearError,
  moderationStatus,
  moderationReason,
}: CharacterFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const telegram = useTelegramMode();
  const isWarned = moderationStatus === "warning";
  // Until the owner picks, follow the card's saved style (the edit page fills it after the first render).
  const [styleChoice, setStyle] = useState<"anime" | "realistic" | null>(null);
  const style = styleChoice ?? (values.artStyle || "realistic");
  const [tokenStatus, setTokenStatus] = useState<AvatarLimitStatus | null>(null);
  const [localErrors, setLocalErrors] = useState<{ name?: string; lora?: string; prompt?: string }>({});

  const usesSd = Boolean(loraFile || loraPreview);
  const generation = useAvatarGeneration(characterId ? `edit:${characterId}` : `create:${values.roleplayMode}`, onAvatarGenerated, setTokenStatus);
  const generatingAvatar = generation.busy;
  const canGenerate = Boolean(tokenStatus && tokenStatus.monthlyRemaining >= 1);

  const handleLoraInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLocalErrors((current) => ({ ...current, lora: undefined }));
    onClearError?.("lora");
    try {
      const ready = await ensureReferenceImageFile(file);
      onLoraChange(ready);
    } catch (error) {
      console.error("[CharacterForm] AVIF conversion failed:", error);
      setLocalErrors((current) => ({
        ...current,
        lora: "Не удалось обработать AVIF. Загрузите PNG или JPEG.",
      }));
    }
  };



  useEffect(() => {
    let cancelled = false;
    axios
      .get<AvatarLimitStatus>("/api/avatar-tokens")
      .then(({ data }) => {
        if (!cancelled) setTokenStatus(data);
      })
      .catch(() => {
        /* баланс подтянется при генерации */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerateAvatar = async () => {
    if (!values.name.trim()) {
      setLocalErrors((current) => ({ ...current, name: "Сначала укажите имя или название" }));
      return;
    }

    setLocalErrors((current) => ({ ...current, name: undefined }));
    onClearError?.("name");
    try {
      const referenceImage = await resolveReferenceImage(loraPreview, loraFile);
      await generation.start({
        name: values.name.trim(), roleplayMode: values.roleplayMode,
        appearance: values.appearance.trim() || undefined,
        description: values.description.trim() || undefined,
        // The prompt writer reads the whole card: scene, tags, world, NPCs and group members.
        scenario: values.scenario.trim() || undefined,
        tags: values.tags.trim() || undefined,
        rpConfig: values.rpConfig,
        avatarPrompt: values.avatarPrompt.trim() || undefined,
        referenceImage: referenceImage || undefined, style,
      });
      onChange("artStyle", style);
    } catch {
      showError("Не удалось прочитать референс. Загрузите другое изображение.");
    }
  };

  return (
    <div className="space-y-4 text-base md:space-y-8">
      {isWarned && <ModerationWarning reason={moderationReason} />}
      <RoleplayCardFields values={values} onChange={onChange} showModePicker={showModePicker} nameError={localErrors.name || errors?.name} onClearNameError={() => {
        setLocalErrors(current => ({ ...current, name: undefined })); onClearError?.("name");
      }} />

      <section className="overflow-hidden rounded-lg border border-[#2a2638] bg-[#0c0b12]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center gap-2 px-4 py-4 text-left transition-colors hover:bg-[#15131d]"
          aria-expanded={advancedOpen}
        >
          <FaCog className={ICON_CLASS} aria-hidden />
          <h2 className="text-base font-bold text-white md:text-lg">Расширенные настройки</h2>
          <FaChevronDown
            className={`ml-auto shrink-0 text-sm text-gray-400 transition-transform duration-200 ${
              advancedOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {advancedOpen && (
          <div className="space-y-4 border-t border-[#2a2638] p-3 md:space-y-8 md:p-4">
            <RoleplayPromptSettings characterId={characterId} values={values} onChange={onChange} />

            <FormBlock
              title="Образцы реплик — необязательно"
              hints={[
                hintWithCounter(
                  "Используйте {{char}} для реплик персонажа и {{user}} для реплик пользователя.",
                  values.exampleDialogs,
                  CHARACTER_LIMITS.exampleDialogs
                ),
                "Пример: {{char}}: Привет! Как дела? {{user}}: Отлично, а у тебя?",
              ]}
            >
              <LimitedTextarea
                id="exampleDialogs"
                value={values.exampleDialogs}
                onChange={(v) => onChange("exampleDialogs", v)}
                maxLength={CHARACTER_LIMITS.exampleDialogs}
                rows={6}
                placeholder={"{{char}}: Привет! Как дела?\n{{user}}: Отлично, а у тебя?"}
              />
            </FormBlock>


          </div>
        )}
      </section>

      <FormBlock title="Теги" icon={FaTags}>
        <CharacterTagPicker value={values.tags} onChange={(v) => onChange("tags", v)} />
      </FormBlock>

      <FormBlock title={values.roleplayMode === "character" ? "Аватар персонажа — необязательно" : "Обложка истории"} icon={FaImage}>
        <ImageUploadField
          preview={avatarPreview}
          onChange={(event) => {
            onClearError?.("avatar");
            onAvatarChange(event);
          }}
          onRemove={onAvatarRemove}
          footerHint="Максимальный размер: 5 МБ. Рекомендуемое соотношение: 3:5."
          error={errors?.avatar}
        />
        <div className="space-y-3">
          <label htmlFor="avatarPrompt" className="block text-sm font-medium text-white">
            Пожелания к изображению (необязательно)
          </label>
          <LimitedTextarea
            id="avatarPrompt"
            value={values.avatarPrompt}
            onChange={(v) => onChange("avatarPrompt", v)}
            maxLength={CHARACTER_LIMITS.avatarPrompt}
            rows={4}
            placeholder={values.roleplayMode === "character" ? "Например: в полный рост, в красном плаще, на фоне ночного города" : values.roleplayMode === "world" ? "Например: вид с крыши на рассвете, туман над каналами" : "Например: все у костра, вечер, тёплый свет"}
          />
          <p className={HINT_CLASS}>
            {hintWithCounter(
              "Изображение строится по всей карточке. Здесь можно уточнить то, что важно именно для картинки: позу, одежду, место, время суток. Пожелания важнее карточки.",
              values.avatarPrompt,
              CHARACTER_LIMITS.avatarPrompt
            )}
          </p>
        </div>
        <details className="rounded-lg border border-[#2a2638] p-3">
          <summary className="cursor-pointer text-sm font-medium text-white">Изображение-референс (необязательно)</summary>
          <div className="mt-3 space-y-3">
            <p className={HINT_CLASS}>Загрузите образец, чтобы сохранить внешность персонажа или композицию обложки. Без образца изображение создаётся по текстовому описанию.</p>
            <ImageUploadField preview={loraPreview} onChange={handleLoraInput} onRemove={onLoraRemove} error={localErrors.lora || errors?.lora} footerHint="PNG, JPEG, WebP или GIF до 5 МБ." />
          </div>
        </details>
        {tokenStatus && (
          <div className="space-y-2 rounded-lg border border-[#2a2638] bg-[#0c0b12] p-3 text-sm text-gray-300">
            <p>
              Месячный лимит: осталось {tokenStatus.monthlyRemaining} из {tokenStatus.monthlyLimit} генераций
            </p>
            <p>
              {usesSd ? "Генерация по референсу" : "Генерация по описанию"}
            </p>
            {tokenStatus.monthlyLimit === 0 && (
              <p className="text-red-400">{telegram ? "Генерация аватара сейчас недоступна." : "Генерация доступна по подписке Диалог, История или Вселенная."}</p>
            )}
            {tokenStatus.monthlyLimit > 0 && tokenStatus.monthlyRemaining === 0 && (
              <p className="text-red-400">Достигнут месячный лимит бесплатных генераций.</p>
            )}
          </div>
        )}
        <p className="text-xs text-wd-text-secondary">Одна генерация создаёт одно изображение. Добавьте референс, чтобы сохранить внешность персонажа.</p>
        {generation.notice && <p role="status" className="text-sm text-amber-400">{generation.notice}</p>}
        {generation.canRestore && <button type="button" onClick={generation.restore} className="text-sm text-wd-secondary underline">Восстановить последнее изображение</button>}
        {(generation.busy || generation.blocked || generation.notice) && <button type="button" onClick={generation.refresh} className="text-sm text-wd-secondary underline">Проверить результат</button>}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div
            className="flex w-full gap-2 sm:w-auto"
            role="radiogroup"
            aria-label="Стиль генерации аватара"
          >
            {(
              [
                { value: "realistic" as const, label: "Реалистичный" },
                { value: "anime" as const, label: "Аниме" },
              ] as const
            ).map((option) => {
              const active = style === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setStyle(option.value)}
                  className={`flex-1 rounded-lg border px-4 py-3 text-sm font-bold transition-colors sm:flex-none ${
                    active
                      ? "border-wd-secondary bg-wd-secondary text-wd-on-secondary"
                      : "border-gray-500 bg-transparent text-gray-400 hover:border-gray-400 hover:text-gray-300"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            id="generate-avatar-btn"
            data-metrika="generate-avatar"
            onClick={handleGenerateAvatar}
            disabled={generatingAvatar || generation.blocked || (tokenStatus !== null && !canGenerate)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-wd-secondary bg-transparent px-4 py-3 text-base font-bold text-white transition-colors hover:bg-wd-secondary/15 disabled:opacity-50 sm:w-auto"
          >
            {generatingAvatar ? (
              <FaSpinner className="animate-spin text-sm" />
            ) : (
              <FaMagic className="text-sm" />
            )}
            {generatingAvatar ? "Генерация..." : values.roleplayMode === "character" ? "Сгенерировать аватар" : "Сгенерировать обложку"}
          </button>
        </div>
      </FormBlock>

      <details className="rounded-lg border border-[#2a2638] p-4">
        <summary className="cursor-pointer font-semibold">Начальные сведения и секреты — необязательно</summary>
        <FormBlock
          title="Память истории — необязательно"
          icon={FaBook}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="publicMemory" className="block text-sm font-medium text-white">
                Публичная память
              </label>
              <LimitedTextarea
                id="publicMemory"
                value={values.publicMemory}
                onChange={(v) => onChange("publicMemory", v)}
                maxLength={MEMORY_CONTENT_LIMIT}
                rows={5}
                placeholder="То, что персонаж рассказывает всем..."
              />
              <p className={HINT_CLASS}>
                {hintWithCounter(
                  "То, что персонаж рассказывает всем. Будет отображаться в карточке и влиять на его поведение.",
                  values.publicMemory,
                  MEMORY_CONTENT_LIMIT
                )}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="privateMemory" className="block text-sm font-medium text-white">
                Приватная память
              </label>
              <LimitedTextarea
                id="privateMemory"
                value={values.privateMemory}
                onChange={(v) => onChange("privateMemory", v)}
                maxLength={MEMORY_CONTENT_LIMIT}
                rows={5}
                placeholder="Секреты, страхи, привычки..."
              />
              <p className={HINT_CLASS}>
                {hintWithCounter(
                  "Секреты, страхи, привычки. Видны только вам. Влияют на поведение персонажа, но не раскрываются напрямую.",
                  values.privateMemory,
                  MEMORY_CONTENT_LIMIT
                )}
              </p>
            </div>
          </div>
        </FormBlock>
      </details>


      <section className="space-y-3">
        <VisibilityToggle isPublic={values.isPublic} onChange={(v) => onChange("isPublic", v)} />
        <p className="text-sm leading-relaxed text-gray-400">
          <Trans
            i18nKey="characterForm.rulesHint"
            components={{
              rules: <LocaleLink href="/rules" className="font-semibold underline hover:text-white" />,
            }}
          />
        </p>
      </section>
    </div>
  );
}
