"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatThreadSummary } from "@/lib/chatThreadShared";
import { storySceneScope } from "@/lib/storySceneShared";
import { useAvatarGeneration, type AvatarLimit } from "@/lib/useAvatarGeneration";

export default function ChatSceneImage({ characterId, thread, onThreadChange }: {
  characterId: string;
  thread: ChatThreadSummary;
  onThreadChange: (thread: ChatThreadSummary) => void;
}) {
  const { t } = useTranslation();
  const [limits, setLimits] = useState<AvatarLimit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const generation = useAvatarGeneration(storySceneScope(thread.id), () => {}, setLimits);
  const available = (limits?.monthlyRemaining ?? 0) > 0;
  const image = generation.image;
  const selected = Boolean(image && thread.sceneAvatarUrl === image.url);

  async function setAvatar(jobId: string | null) {
    setSaving(true);
    setError(false);
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(characterId)}/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sceneAvatarJobId: jobId }),
      });
      if (!response.ok) throw new Error("Story avatar update failed");
      const data = await response.json() as { thread: ChatThreadSummary };
      onThreadChange(data.thread);
    } catch { setError(true); }
    finally { setSaving(false); }
  }

  return <div className="space-y-4">
    <p className="text-sm text-wd-text-secondary">{t("storyScene.hint")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="wd-btn" disabled={!available || generation.busy || generation.blocked}
        onClick={() => void generation.start({})}>
        {generation.busy ? t("storyScene.generating") : t("storyScene.generate")}
      </button>
      {available && <span className="text-xs text-wd-text-secondary">{t("storyScene.allowance")}</span>}
      {limits && !available && <span role="status" className="text-xs text-wd-text-secondary">{t("storyScene.unavailable")}</span>}
    </div>
    {generation.notice && <p role="status" className="text-sm text-wd-text-secondary">{generation.notice}</p>}
    {image && <figure className="space-y-3">
      {/* A private URL must be loaded by the browser with the viewer's session. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={t("storyScene.title")} width={1024} height={1024} className="aspect-square w-full max-w-sm rounded-xl object-cover" />
      {selected ? <p role="status" className="text-sm font-semibold">{t("storyScene.selected")}</p> :
        <button type="button" className="wd-btn" disabled={saving} onClick={() => void setAvatar(image.jobId)}>{t("storyScene.apply")}</button>}
    </figure>}
    {thread.sceneAvatarUrl && <button type="button" disabled={saving} className="text-sm text-wd-text-secondary underline"
      onClick={() => void setAvatar(null)}>{t("storyScene.reset")}</button>}
    {error && <p role="alert" className="text-sm text-red-400">{t("storyScene.saveFailed")}</p>}
  </div>;
}
