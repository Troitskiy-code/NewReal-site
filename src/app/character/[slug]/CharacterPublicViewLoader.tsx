"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CharacterPublicView, { type CharacterPublicViewData } from "./CharacterPublicView";
import { characterAvatarPath } from "@/lib/characterCardImage";

type LoaderState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; character: CharacterPublicViewData };

function toViewData(raw: Record<string, unknown>): CharacterPublicViewData | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;

  const user =
    raw.user && typeof raw.user === "object"
      ? (raw.user as { name?: string | null; image?: string | null })
      : {};

  const createdAt =
    typeof raw.createdAt === "string"
      ? raw.createdAt
      : raw.createdAt instanceof Date
        ? raw.createdAt.toISOString()
        : new Date().toISOString();
  const updatedAt =
    typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : raw.updatedAt instanceof Date
        ? raw.updatedAt.toISOString()
        : null;

  return {
    id: raw.id,
    slug: typeof raw.slug === "string" ? raw.slug : "",
    name: raw.name,
    name_en: typeof raw.name_en === "string" ? raw.name_en : null,
    description: typeof raw.description === "string" ? raw.description : null,
    description_en: typeof raw.description_en === "string" ? raw.description_en : null,
    descriptionCard: typeof raw.descriptionCard === "string" ? raw.descriptionCard : null,
    descriptionCard_en: typeof raw.descriptionCard_en === "string" ? raw.descriptionCard_en : null,
    imageUrl: characterAvatarPath(raw.id, updatedAt),
    publicMemory: raw.publicMemory ?? null,
    publicMemory_en: raw.publicMemory_en ?? null,
    totalMessages: typeof raw.totalMessages === "number" ? raw.totalMessages : 0,
    createdAt,
    updatedAt,
    user: {
      name: typeof user.name === "string" ? user.name : null,
      image: typeof user.image === "string" ? user.image : null,
    },
  };
}

export default function CharacterPublicViewLoader({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoaderState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    fetch(`/api/characters/slug/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("not-found");
        const payload = (await response.json()) as Record<string, unknown>;
        const character = toViewData(payload);
        if (!character) throw new Error("invalid");
        setState({ status: "ready", character });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("[Character] Client fetch failed", { slug, error });
        setState({ status: "error" });
      });

    return () => controller.abort();
  }, [slug]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h1 className="text-2xl font-black text-white">{t("meta.character.fallbackTitle")}</h1>
        <p className="mt-2 text-sm text-wd-text-secondary">{t("meta.character.fallbackDescription")}</p>
      </div>
    );
  }

  return <CharacterPublicView character={state.character} />;
}
