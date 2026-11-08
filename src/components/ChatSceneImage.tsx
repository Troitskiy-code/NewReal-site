"use client";

/* Story illustrations are private: the browser loads them with the viewer's session, not through next/image. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowLeft, LuChevronRight, LuImage, LuLoaderCircle, LuTrash2, LuUser } from "react-icons/lu";
import type { ChatThreadSummary } from "@/lib/chatThreadShared";
import { storySceneScope, type StorySceneItem } from "@/lib/storySceneShared";
import { useAvatarGeneration } from "@/lib/useAvatarGeneration";

const CHARACTER = "character";
const STRIP_SIZE = 5;

async function fetchScenes(threadId: string) {
  const response = await fetch(`/api/story-scene-media/${encodeURIComponent(threadId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Gallery request failed");
  return await response.json() as { scenes: StorySceneItem[]; limit: number };
}

function currentJobId(thread: ChatThreadSummary) {
  return thread.sceneAvatarUrl?.split("/").pop() ?? null;
}

export default function ChatSceneImage({ characterId, characterName, characterAvatarUrl, thread, onThreadChange }: {
  characterId: string;
  characterName: string;
  characterAvatarUrl?: string | null;
  thread: ChatThreadSummary;
  onThreadChange: (thread: ChatThreadSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const [scenes, setScenes] = useState<StorySceneItem[] | null>(null);
  const [limit, setLimit] = useState(100);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<"panel" | "gallery">("panel");
  /** A scene's job id, CHARACTER for the card avatar, or null to follow the story's current avatar. */
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const applyScenes = useCallback((data: { scenes: StorySceneItem[]; limit: number }, select?: string) => {
    setScenes(data.scenes);
    setLimit(data.limit);
    setLoadFailed(false);
    if (select) setPicked(data.scenes.find(scene => scene.url === select)?.jobId ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    fetchScenes(thread.id).then(data => { if (active) applyScenes(data); }, () => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [thread.id, applyScenes]);

  // A finished launch from this panel shows the new illustration first.
  const onImage = useCallback((url: string) => {
    fetchScenes(thread.id).then(data => applyScenes(data, url), () => setLoadFailed(true));
  }, [thread.id, applyScenes]);
  const noLimits = useCallback(() => {}, []);
  const generation = useAvatarGeneration(storySceneScope(thread.id), onImage, noLimits);
  const quote = generation.sceneQuote;
  const insufficient = quote !== null && quote.verseCoins < quote.priceVC;
  const full = scenes !== null && scenes.length >= limit;

  const avatarJobId = currentJobId(thread);
  const shownId = picked ?? avatarJobId ?? scenes?.[0]?.jobId ?? CHARACTER;
  const shownScene = scenes?.find(scene => scene.jobId === shownId) ?? null;
  const showsCharacter = !shownScene;
  const isCurrent = showsCharacter ? !avatarJobId : shownScene.jobId === avatarJobId;

  async function setAvatar(jobId: string | null) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(characterId)}/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sceneAvatarJobId: jobId }),
      });
      if (!response.ok) throw new Error("Story avatar update failed");
      onThreadChange((await response.json() as { thread: ChatThreadSummary }).thread);
    } catch { setError(t("storyScene.saveFailed")); }
    finally { setSaving(false); }
  }

  async function deleteScene(jobId: string) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/story-scene-media/${encodeURIComponent(thread.id)}/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Story scene delete failed");
      onThreadChange((await response.json() as { thread: ChatThreadSummary }).thread);
      setScenes(current => current?.filter(scene => scene.jobId !== jobId) ?? current);
      setPicked(null);
    } catch { setError(t("storyScene.deleteFailed")); }
    finally { setSaving(false); setConfirmDelete(false); }
  }

  function pick(id: string) {
    setPicked(id);
    setConfirmDelete(false);
    setError(null);
  }

  const date = shownScene ? new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .format(new Date(shownScene.createdAt)) : null;

  const characterTile = (round: boolean) => <span className={`flex h-full w-full items-center justify-center overflow-hidden bg-[#2a2638] text-secondary-text ${round ? "rounded-full" : "rounded-lg"}`}>
    {characterAvatarUrl ? <img src={characterAvatarUrl} alt="" className="h-full w-full object-cover" /> : <LuUser size={20} aria-hidden />}
  </span>;

  const tileRing = (id: string) => shownId === id ? "ring-2 ring-primary ring-offset-2 ring-offset-[#15131d]" : "";

  const avatarAction = isCurrent
    ? <span role="status" className="flex min-h-[40px] flex-1 items-center justify-center rounded-full border border-divider px-3 text-xs text-secondary-text">{t("storyScene.current")}</span>
    : <button type="button" disabled={saving} onClick={() => void setAvatar(showsCharacter ? null : shownScene.jobId)}
      className="min-h-[40px] flex-1 rounded-full border border-divider px-3 text-xs font-semibold text-white transition-colors hover:bg-[#2a2638] disabled:opacity-50">
      {showsCharacter ? t("storyScene.useCharacter") : t("storyScene.setAvatar")}
    </button>;

  const deleteControls = shownScene && (confirmDelete
    ? <div role="alertdialog" aria-label={t("storyScene.deleteConfirm")} className="flex flex-wrap items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs">
      <span className="flex-1">{t("storyScene.deleteConfirm")}</span>
      <button type="button" disabled={saving} onClick={() => void deleteScene(shownScene.jobId)}
        className="rounded-full bg-red-500/80 px-3 py-1.5 font-semibold text-white disabled:opacity-50">{t("storyScene.delete")}</button>
      <button type="button" onClick={() => setConfirmDelete(false)} className="px-2 py-1.5 text-secondary-text">{t("storyScene.cancel")}</button>
    </div>
    : <button type="button" aria-label={t("storyScene.delete")} title={t("storyScene.delete")} onClick={() => setConfirmDelete(true)}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-divider text-secondary-text transition-colors hover:text-white">
      <LuTrash2 size={16} aria-hidden />
    </button>);

  const status = <>
    {generation.notice && <p role="status" className="text-xs text-secondary-text">{generation.notice}</p>}
    {insufficient && <p role="status" className="text-xs text-secondary-text">{t("storyScene.insufficient")}</p>}
    {full && <p role="status" className="text-xs text-secondary-text">{t("storyScene.galleryFull", { limit })}</p>}
    {loadFailed && <p role="alert" className="text-xs text-red-400">{t("storyScene.loadFailed")}</p>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </>;

  if (view === "gallery") {
    return <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => { setView("panel"); setConfirmDelete(false); }}
          className="flex items-center gap-1.5 text-sm text-secondary-text transition-colors hover:text-white">
          <LuArrowLeft size={16} aria-hidden /> {t("storyScene.back")}
        </button>
        <span className="text-xs text-secondary-text">{t("storyScene.count", { count: scenes?.length ?? 0, limit })}</span>
      </div>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={t("storyScene.galleryTitle")}>
        <li>
          <button type="button" onClick={() => pick(CHARACTER)} aria-pressed={showsCharacter}
            className={`block aspect-square w-full rounded-lg ${tileRing(CHARACTER)}`} aria-label={t("storyScene.characterAvatar", { name: characterName })}>
            {characterTile(false)}
          </button>
          <span className="mt-1 block truncate text-center text-[11px] text-secondary-text">{!avatarJobId ? t("storyScene.current") : characterName}</span>
        </li>
        {scenes?.map(scene => <li key={scene.jobId}>
          <button type="button" onClick={() => pick(scene.jobId)} aria-pressed={shownId === scene.jobId}
            className={`block aspect-square w-full overflow-hidden rounded-lg bg-[#2a2638] ${tileRing(scene.jobId)}`}>
            <img src={scene.thumbUrl} alt={t("storyScene.title")} loading="lazy" width={384} height={384} className="h-full w-full object-cover" />
          </button>
          {scene.jobId === avatarJobId && <span className="mt-1 block text-center text-[11px] text-primary">{t("storyScene.current")}</span>}
        </li>)}
      </ul>
      <div className="sticky bottom-0 space-y-2 border-t border-divider bg-[#15131d] pt-3">
        {date && <p className="text-xs text-secondary-text">{date}</p>}
        <div className="flex items-center gap-2">{avatarAction}{!confirmDelete && deleteControls}</div>
        {confirmDelete && deleteControls}
        {status}
      </div>
    </div>;
  }

  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3 text-xs text-secondary-text">
      <span>{quote ? t("storyScene.balance", { balance: quote.verseCoins }) : " "}</span>
      {date && <span>{date}</span>}
    </div>
    <div className="relative mx-auto aspect-square w-full max-w-sm overflow-hidden rounded-xl bg-[#211d2c]">
      {generation.busy ? <div role="status" className="flex h-full flex-col items-center justify-center gap-3 text-sm text-secondary-text">
        <LuLoaderCircle size={28} className="animate-spin" aria-hidden />{t("storyScene.generating")}
      </div> : shownScene ? <img src={shownScene.url} alt={t("storyScene.title")} width={1024} height={1024} className="h-full w-full object-cover" />
        : characterAvatarUrl ? <img src={characterAvatarUrl} alt={t("storyScene.characterAvatar", { name: characterName })} className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center text-secondary-text"><LuImage size={32} aria-hidden /></div>}
    </div>
    <div className="flex gap-2">
      <button type="button" disabled={!quote || insufficient || full || generation.busy || generation.blocked}
        onClick={() => { if (quote) void generation.start({ acceptedPriceVC: quote.priceVC }); }}
        className="min-h-[40px] flex-1 rounded-full bg-primary px-3 text-xs font-bold text-white transition-colors hover:bg-primary-hover disabled:bg-primary/40">
        {generation.busy ? t("storyScene.generating") : t("storyScene.newPaid", { price: quote?.priceVC ?? 60 })}
      </button>
      {avatarAction}
    </div>
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => pick(CHARACTER)} aria-pressed={showsCharacter}
        aria-label={t("storyScene.characterAvatar", { name: characterName })}
        className={`h-11 w-11 shrink-0 rounded-full ${tileRing(CHARACTER)}`}>{characterTile(true)}</button>
      {scenes?.slice(0, STRIP_SIZE).map(scene => <button key={scene.jobId} type="button" onClick={() => pick(scene.jobId)}
        aria-pressed={shownId === scene.jobId} aria-label={t("storyScene.title")}
        className={`h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-[#2a2638] ${tileRing(scene.jobId)}`}>
        <img src={scene.thumbUrl} alt="" width={384} height={384} className="h-full w-full object-cover" />
      </button>)}
      {!!scenes?.length && <button type="button" onClick={() => setView("gallery")}
        className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-secondary-text transition-colors hover:text-white">
        {t("storyScene.all", { count: scenes.length })} <LuChevronRight size={14} aria-hidden />
      </button>}
    </div>
    {status}
    <p className="text-[11px] leading-relaxed text-secondary-text">{t("storyScene.hint")}</p>
  </div>;
}
