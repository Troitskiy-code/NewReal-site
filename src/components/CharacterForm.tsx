"use client";

import { useState } from "react";
import type { IconType } from "react-icons";
import {
  FaChevronDown,
  FaCog,
  FaCommentDots,
  FaIdCard,
  FaImage,
  FaInfoCircle,
  FaTags,
  FaUser,
} from "react-icons/fa";
import { CHARACTER_LIMITS } from "@/lib/characterFields";
import CharacterTagPicker from "@/components/CharacterTagPicker";
import ToggleSwitch from "@/components/ToggleSwitch";

const ICON_CLASS = "mr-2 shrink-0 text-[18px] text-gray-400";
const HINT_CLASS = "text-sm text-gray-400 leading-relaxed";
const INPUT_CLASS =
  "w-full rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-base text-white outline-none transition-colors placeholder:text-gray-400 focus:border-[#6C63FF]";

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
};

function ImageUploadField({ preview, onChange, onRemove, footerHint }: ImageUploadProps) {
  return (
    <div className="space-y-3">
      <div className="relative flex min-h-[160px] flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-500 bg-[#0A0A0A] p-6 transition-colors hover:border-[#6C63FF]/50">
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
  const active = "border-[#6C63FF] bg-[#6C63FF] text-white";
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
  isPublic: boolean;
  isNSFW: boolean;
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
  isPublic: false,
  isNSFW: false,
};

type CharacterFormProps = {
  values: CharacterFormValues;
  onChange: <K extends keyof CharacterFormValues>(field: K, value: CharacterFormValues[K]) => void;
  avatarPreview: string | null;
  onAvatarChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAvatarRemove: () => void;
  loraPreview: string | null;
  onLoraChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onLoraRemove: () => void;
};

export default function CharacterForm({
  values,
  onChange,
  avatarPreview,
  onAvatarChange,
  onAvatarRemove,
  loraPreview,
  onLoraChange,
  onLoraRemove,
}: CharacterFormProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4 text-base md:space-y-8">
      <FormBlock title="Имя персонажа" icon={FaUser}>
        <input
          id="name"
          type="text"
          value={values.name}
          onChange={(e) => onChange("name", e.target.value)}
          placeholder="Введите имя персонажа"
          required
          className={INPUT_CLASS}
        />
      </FormBlock>

      <FormBlock
        title="Внешность"
        icon={FaImage}
        hints={[
          hintWithCounter(
            "Влияет на поведение и генерацию изображений.",
            values.appearance,
            CHARACTER_LIMITS.appearance
          ),
        ]}
      >
        <LimitedTextarea
          id="appearance"
          value={values.appearance}
          onChange={(v) => onChange("appearance", v)}
          maxLength={CHARACTER_LIMITS.appearance}
          rows={5}
          placeholder="Опишите внешность персонажа..."
        />
      </FormBlock>

      <FormBlock
        title="Описание персонажа"
        icon={FaInfoCircle}
        hints={[
          hintWithCounter(
            "Расскажи про персонажа: его характер, поведение, привычки, личную историю. Чем больше деталей, тем живее персонаж!",
            values.description,
            CHARACTER_LIMITS.description
          ),
          "Влияет на поведение персонажа.",
        ]}
      >
        <LimitedTextarea
          id="description"
          value={values.description}
          onChange={(v) => onChange("description", v)}
          maxLength={CHARACTER_LIMITS.description}
          rows={6}
          placeholder="Характер, манера речи, предыстория..."
        />
      </FormBlock>

      <FormBlock
        title="Первое сообщение"
        icon={FaCommentDots}
        hints={[
          hintWithCounter(
            "Опишите начало сцены, первые слова персонажа. Первое сообщение при начале беседы.",
            values.greeting,
            CHARACTER_LIMITS.greeting
          ),
        ]}
      >
        <LimitedTextarea
          id="greeting"
          value={values.greeting}
          onChange={(v) => onChange("greeting", v)}
          maxLength={CHARACTER_LIMITS.greeting}
          rows={5}
          placeholder="Первые слова персонажа при начале чата..."
        />
      </FormBlock>

      <section className="overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#0A0A0A]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center gap-2 px-4 py-4 text-left transition-colors hover:bg-[#1A1A1A]"
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
          <div className="space-y-4 border-t border-[#2A2A2A] p-3 md:space-y-8 md:p-4">
            <FormBlock
              title="Сценарий и окружение"
              hints={[
                hintWithCounter(
                  "Пара предложений о том, что происходит или будет происходить. ИИ будет стараться следовать сценарию.",
                  values.scenario,
                  CHARACTER_LIMITS.scenario
                ),
              ]}
            >
              <LimitedTextarea
                id="scenario"
                value={values.scenario}
                onChange={(v) => onChange("scenario", v)}
                maxLength={CHARACTER_LIMITS.scenario}
                rows={4}
                placeholder="Пара предложений о том, что происходит или будет происходить..."
              />
            </FormBlock>

            <FormBlock
              title="Примеры диалогов"
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

            <FormBlock title="Аватар для улучшенной генерации">
              <p className={HINT_CLASS}>
                Используется для улучшенной генерации изображений: по этой фотографии система будет
                точнее повторять образ, черты лица и внешний вид персонажа.
              </p>
              <ul className={`list-disc space-y-1 pl-5 ${HINT_CLASS}`}>
                <li>
                  Если не загрузить, генерация будет ориентироваться на обычный аватар персонажа.
                </li>
                <li>
                  Лучше всего подходит четкое изображение лица или полный образ без лишних деталей.
                </li>
              </ul>
              <ImageUploadField preview={loraPreview} onChange={onLoraChange} onRemove={onLoraRemove} />
            </FormBlock>
          </div>
        )}
      </section>

      <FormBlock
        title="Описание карточки персонажа"
        icon={FaIdCard}
        hints={[
          hintWithCounter(
            "Не влияет на поведение персонажа. Эта информация появится в карточке персонажа.",
            values.descriptionCard,
            CHARACTER_LIMITS.descriptionCard
          ),
        ]}
      >
        <LimitedTextarea
          id="descriptionCard"
          value={values.descriptionCard}
          onChange={(v) => onChange("descriptionCard", v)}
          maxLength={CHARACTER_LIMITS.descriptionCard}
          rows={3}
          placeholder="Краткий текст для карточки в галерее..."
        />
      </FormBlock>

      <FormBlock title="Теги" icon={FaTags}>
        <CharacterTagPicker value={values.tags} onChange={(v) => onChange("tags", v)} />
      </FormBlock>

      <FormBlock title="Аватар персонажа" icon={FaImage}>
        <ImageUploadField
          preview={avatarPreview}
          onChange={onAvatarChange}
          onRemove={onAvatarRemove}
          footerHint="Максимальный размер: 5 МБ. Рекомендуемое соотношение: 3:5."
        />
      </FormBlock>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0 space-y-1">
            <span className="block text-base font-bold text-white md:text-lg">18+ контент</span>
            <span className="block text-sm text-gray-400">
              Отметьте, если персонаж содержит контент для взрослых (NSFW)
            </span>
          </div>
          <ToggleSwitch
  isOn={values.isNSFW}
  onToggle={(value) => onChange("isNSFW", value)}
  label="NSFW"
/>
        </div>
      </section>

      <section>
        <VisibilityToggle isPublic={values.isPublic} onChange={(v) => onChange("isPublic", v)} />
      </section>
    </div>
  );
}
