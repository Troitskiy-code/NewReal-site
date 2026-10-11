"use client";
import { useState } from "react";
import axios from "axios";
import type { CharacterFormValues } from "./CharacterForm";
import { RP_FIELD_LIMITS, type RoleplayTextConfig, type RoleplayStyle } from "@/lib/roleplayConfig";
import { showError, showSuccess } from "@/lib/toast";

const LABELS: Record<keyof RoleplayTextConfig, string> = {
  motivations: "Мотивы и цели", speechStyle: "Манера речи", relationships: "Отношения",
  world: "Мир и его устройство", narrativeRules: "Манера повествования", canonicalNotes: "Уточнения фактов", npcs: "Действующие лица",
};
const inputClass = "w-full rounded-lg border border-wd-border bg-wd-bg p-3 text-base text-wd-text";
export default function RoleplayPromptSettings({ characterId, values, onChange }: {
  characterId?: string; values: CharacterFormValues;
  onChange: <K extends keyof CharacterFormValues>(field: K, value: CharacterFormValues[K]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ content: string; version: string; rolloutEnabled: boolean; modelName: string | null; parameters: unknown; diagnostics: unknown } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (error) { showError(axios.isAxiosError(error) ? error.response?.data?.error ?? "Не удалось выполнить действие" : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  };
  const switchVersion = (version: number) => run(async () => {
    if (!confirmed) return;
    await axios.post(`/api/characters/${characterId}/prompt-version`, { version, confirmed: true });
    onChange("promptBuilderVersion", version);
    setConfirmed(false); setPreview(null);
    showSuccess("Настройка новых историй обновлена. Текущие чаты сохраняют свою версию.");
  });
  return <section className="space-y-4 rounded-xl border border-wd-border p-4">
    <h2 className="text-lg font-semibold">Стиль и дополнительные настройки</h2>
    <label className="block space-y-2"><span>Стиль ответа</span><select className={inputClass} value={values.roleplayStyle} onChange={event => onChange("roleplayStyle", event.target.value as RoleplayStyle)}>
      <option value="dialogue">Диалог</option><option value="narrative">Повествование</option><option value="mixed">Смешанный RP</option>
    </select></label>
    {(values.roleplayMode === "character" ? ["speechStyle"] as const : ["narrativeRules"] as const).map(field => <label key={field} className="block space-y-2"><span>{LABELS[field]} — необязательно</span>
      <textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS[field]} value={values.rpConfig[field] ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, [field]: event.target.value })} />
    </label>)}
    {characterId && <label className="block space-y-2"><span>Уточнения фактов — необязательно</span><textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS.canonicalNotes} value={values.rpConfig.canonicalNotes ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, canonicalNotes: event.target.value })} /></label>}
    {(["motivations", "relationships", "world"] as const).some(field => values.rpConfig[field]) && <details><summary>Сведения из прежнего редактора</summary>
      <p className="my-2 text-sm text-wd-muted">Эти заполненные поля сохранены и учитываются. Их можно объединить с основным описанием, затем очистить здесь.</p>
      {(["motivations", "relationships", "world"] as const).filter(field => values.rpConfig[field]).map(field => <label key={field} className="mb-3 block space-y-2"><span>{LABELS[field]}</span><textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS[field]} value={values.rpConfig[field] ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, [field]: event.target.value })} /></label>)}
    </details>}
    <p className="text-sm text-wd-muted">Сценарий задаёт начало. Исправления канона уточняют конкретные факты и не стирают произошедшие события. Для перезапуска используйте «Начать новый чат».</p>
    <button type="button" className="wd-btn" disabled={busy} onClick={() => run(async () => {
      const { data } = await axios.post("/api/characters/prompt-preview", { ...values, ...(characterId ? { characterId } : {}) });
      setPreview(data);
    })}>Предпросмотр инструкций</button>
    {preview && <div className="space-y-2">
      <p className="text-sm text-wd-muted">Предпросмотр текущих полей, без памяти и сообщений конкретного чата. Для обновления нажмите кнопку ещё раз. {preview.rolloutEnabled ? "Новая сборка включена оператором." : "Новая сборка пока выключена оператором."}</p>
      <textarea readOnly aria-label="Итоговые инструкции карточки" className={inputClass} rows={14} value={preview.content} />
      <details><summary>Диагностика сборки и параметры выбранной модели</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ version: preview.version, model: preview.modelName, parameters: preview.parameters, diagnostics: preview.diagnostics }, null, 2)}</pre></details>
    </div>}
    {characterId && <details className="space-y-3"><summary>Переход со старых инструкций и откат</summary>
      <p className="text-sm text-wd-muted">Текущая версия карточки: {values.promptBuilderVersion}. Старый текст сохраняется без изменений. Его происхождение может быть неизвестно: перенесите нужные особенности вручную в поля карточки и сохраните их до переключения. Новая сборка не выполняет старый текст; текущие истории переключаются отдельно в чате.</p>
      {values.systemPrompt && <textarea readOnly aria-label="Архив старых инструкций" className={inputClass} rows={7} value={values.systemPrompt} />}
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю выбор версии после сохранения карточки</label>
      <div className="flex flex-wrap gap-3"><button className="wd-btn" type="button" disabled={busy || !confirmed} onClick={() => switchVersion(2)}>Включить новую сборку для новых историй</button>
        <button className="wd-btn" type="button" disabled={busy || !confirmed || values.roleplayMode === "group"} onClick={() => switchVersion(1)}>Вернуть прежнюю сборку</button></div>
      {values.roleplayMode === "group" && <p className="text-sm text-wd-muted">Группа работает только с новой сборкой. Для возврата к прежним инструкциям сначала смените тип карточки и сохраните её.</p>}
    </details>}
  </section>;
}
