"use client";
import { useState } from "react";
import axios from "axios";
import { showError, showSuccess } from "@/lib/toast";
import { ROLEPLAY_MODES, ROLEPLAY_MODE_LABELS, type RoleplayMode } from "@/lib/roleplayConfig";
import { withThread } from "@/lib/chatThreadShared";
import { usePromptRolloutFinalized } from "@/hooks/usePromptRollout";

export default function ChatPromptVersionSettings({ characterId, threadId = null, threadsEnabled = false, disabled }: { characterId: string; threadId?: string | null; threadsEnabled?: boolean; disabled?: boolean }) {
  const finalized = usePromptRolloutFinalized();
  const [state, setState] = useState<{ builderVersion: number; mode: RoleplayMode; cardVersion: number; rolloutEnabled: boolean } | null>(null);
  const [mode, setMode] = useState<RoleplayMode>("character");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (version?: number) => {
    setBusy(true);
    try {
      if (version) {
        if (!confirmed) return;
        await axios.post(withThread(`/api/chat/${characterId}/prompt-version`, threadId), { version, mode, confirmed: true });
        showSuccess("Настройки этой истории обновлены. Память и сообщения сохранены.");
      }
      const { data } = await axios.get(withThread(`/api/chat/${characterId}/prompt-version`, threadId));
      setState(data); setMode(data.mode); setConfirmed(false);
    } catch (error) { showError(axios.isAxiosError(error) ? error.response?.data?.error ?? "Не удалось загрузить настройки" : "Не удалось загрузить настройки"); }
    finally { setBusy(false); }
  };
  if (finalized) return null;
  return <details className="my-4 rounded-xl border border-wd-border p-3"><summary>Правила и тип этой истории</summary>
    <button type="button" className="wd-btn my-3" disabled={busy || disabled} onClick={() => act()}>Проверить настройки</button>
    {state && <div className="space-y-3">
      <p className="text-sm">Версия {state.builderVersion}, режим: {ROLEPLAY_MODE_LABELS[state.mode]}.</p>
      <p className="text-sm text-wd-text-secondary">Изменение карточки не переключает эту историю автоматически. Явное переключение сохраняет память и сообщения; старые ручные инструкции могут перестать действовать. {threadsEnabled ? "Начать заново по актуальной карточке — «Новая история»; эта история при этом сохранится." : "Полный перезапуск — отдельное действие «Начать новый чат»."}</p>
      {state.builderVersion === 1 && <p className="text-sm text-wd-text-secondary">В прежней версии роль задаётся сохранённым текстом; её происхождение может быть неизвестно. Выбранный здесь тип действует после перехода на новую сборку.</p>}
      <label className="block">Тип этой истории<select className="ml-2 rounded border border-wd-border bg-wd-bg p-2" value={mode} onChange={event => setMode(event.target.value as RoleplayMode)}>{ROLEPLAY_MODES.map(item => <option key={item} value={item}>{ROLEPLAY_MODE_LABELS[item]}</option>)}</select></label>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю изменение этой истории</label>
      <div className="flex flex-wrap gap-2"><button type="button" className="wd-btn" disabled={busy || disabled || !confirmed || !state.rolloutEnabled || state.cardVersion !== 2} onClick={() => act(2)}>Использовать новую сборку</button><button type="button" className="wd-btn" disabled={busy || disabled || !confirmed || mode === "group"} onClick={() => act(1)}>Вернуть прежнюю сборку</button></div>
      {mode === "group" && <p className="text-sm text-wd-text-secondary">Групповой режим использует версию 2. Состав обновляется владельцем в карточке; сообщения и память остаются общей историей.</p>}
      {(!state.rolloutEnabled || state.cardVersion !== 2) && <p className="text-sm text-wd-text-secondary">Новую сборку ещё должен включить оператор или владелец карточки.</p>}
    </div>}
  </details>;
}
