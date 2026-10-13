"use client";
import { useState } from "react";
import axios from "axios";
import { showError, showSuccess } from "@/lib/toast";
import { ROLEPLAY_MODES, ROLEPLAY_MODE_LABELS, type RoleplayMode } from "@/lib/roleplayConfig";
import { withThread } from "@/lib/chatThreadShared";

// Settings belong to the open story (thread); without one they apply to the next story created.
export default function ChatStorySettings({ characterId, threadId = null, disabled }: { characterId: string; threadId?: string | null; disabled?: boolean }) {
  const [saved, setSaved] = useState<RoleplayMode | null>(null);
  const [mode, setMode] = useState<RoleplayMode>("character");
  const [busy, setBusy] = useState(false);
  const act = async (write = false) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const { data } = write
        ? await axios.post(withThread(`/api/chat/${characterId}/story-settings`, threadId), { mode })
        : await axios.get(withThread(`/api/chat/${characterId}/story-settings`, threadId));
      setSaved(data.mode); setMode(data.mode);
      if (write) showSuccess("Тип истории обновлён. Память и сообщения сохранены.");
    } catch (error) { showError(axios.isAxiosError(error) ? error.response?.data?.error ?? "Не удалось загрузить настройки" : "Не удалось загрузить настройки"); }
    finally { setBusy(false); }
  };
  return <details className="my-4 rounded-xl border border-wd-border p-3"><summary>Тип этой истории</summary>
    <button type="button" className="wd-btn my-3" disabled={busy || disabled} onClick={() => act()}>Настроить тип истории</button>
    {saved && <div className="space-y-3">
      <p className="text-sm text-wd-text-secondary">Изменение типа сохраняет память и сообщения. Для полного перезапуска используйте «Начать новый чат».</p>
      <label className="block">Тип истории<select className="ml-2 rounded border border-wd-border bg-wd-bg p-2" disabled={busy || disabled} value={mode} onChange={event => setMode(event.target.value as RoleplayMode)}>{ROLEPLAY_MODES.map(item => <option key={item} value={item}>{ROLEPLAY_MODE_LABELS[item]}</option>)}</select></label>
      <button type="button" className="wd-btn" disabled={busy || disabled || mode === saved} onClick={() => act(true)}>Применить</button>
      {mode === "group" && <p className="text-sm text-wd-text-secondary">Состав участников задаётся в карточке. Участники используют общую историю и память.</p>}
    </div>}
  </details>;
}
