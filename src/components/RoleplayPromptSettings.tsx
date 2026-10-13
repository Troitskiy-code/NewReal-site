"use client";
import { useState } from "react";
import axios from "axios";
import type { CharacterFormValues } from "./CharacterForm";
import { RP_FIELD_LIMITS, type RoleplayTextConfig, type RoleplayStyle } from "@/lib/roleplayConfig";
import { showError } from "@/lib/toast";

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
  const [preview, setPreview] = useState<{ content: string; version: string; modelName: string | null; parameters: unknown; diagnostics: unknown } | null>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (error) { showError(axios.isAxiosError(error) ? error.response?.data?.error ?? "Не удалось выполнить действие" : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border border-wd-border p-4">
    <h2 className="text-lg font-semibold">Стиль и дополнительные настройки</h2>
    <label className="block space-y-2"><span>Стиль ответа</span><select className={inputClass} value={values.roleplayStyle} onChange={event => onChange("roleplayStyle", event.target.value as RoleplayStyle)}>
      <option value="dialogue">Диалог</option><option value="narrative">Повествование</option><option value="mixed">Смешанный RP</option>
    </select></label>
    {(values.roleplayMode === "character" ? ["speechStyle"] as const : ["narrativeRules"] as const).map(field => <label key={field} className="block space-y-2"><span>{LABELS[field]} — необязательно</span>
      <textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS[field]} value={values.rpConfig[field] ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, [field]: event.target.value })} />
    </label>)}
    {characterId && <label className="block space-y-2"><span>Уточнения фактов — необязательно</span><textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS.canonicalNotes} value={values.rpConfig.canonicalNotes ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, canonicalNotes: event.target.value })} /></label>}
    {(["motivations", "relationships", "world"] as const).some(field => values.rpConfig[field]) && <details><summary>Дополнительные сведения</summary>
      <p className="my-2 text-sm text-wd-text-secondary">Эти заполненные поля сохранены и учитываются. Их можно объединить с основным описанием, затем очистить здесь.</p>
      {(["motivations", "relationships", "world"] as const).filter(field => values.rpConfig[field]).map(field => <label key={field} className="mb-3 block space-y-2"><span>{LABELS[field]}</span><textarea className={inputClass} rows={3} maxLength={RP_FIELD_LIMITS[field]} value={values.rpConfig[field] ?? ""} onChange={event => onChange("rpConfig", { ...values.rpConfig, [field]: event.target.value })} /></label>)}
    </details>}
    <p className="text-sm text-wd-text-secondary">Сценарий задаёт начало. Исправления канона уточняют конкретные факты и не стирают произошедшие события. Для перезапуска используйте «Начать новый чат».</p>
    <button type="button" className="wd-btn" disabled={busy} onClick={() => run(async () => {
      const { data } = await axios.post("/api/characters/prompt-preview", { ...values, ...(characterId ? { characterId } : {}) });
      setPreview(data);
    })}>Предпросмотр инструкций</button>
    {preview && <div className="space-y-2">
      <p className="text-sm text-wd-text-secondary">Предпросмотр текущих полей, без памяти и сообщений конкретного чата. Для обновления нажмите кнопку ещё раз. </p>
      <textarea readOnly aria-label="Итоговые инструкции карточки" className={inputClass} rows={14} value={preview.content} />
      <details><summary>Диагностика сборки и параметры выбранной модели</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ version: preview.version, model: preview.modelName, parameters: preview.parameters, diagnostics: preview.diagnostics }, null, 2)}</pre></details>
    </div>}

  </section>;
}
