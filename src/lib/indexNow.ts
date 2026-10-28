import { after } from "next/server";
import { LOCALES } from "./i18nConfig";
import config from "./indexNowConfig.json";
import { isAdultCharacter } from "./characterSeoContent";
import { memoryToText } from "./persistentMemory";
import { errorLog } from "./logger";

type CharacterChange = {
  isPublic: boolean;
  slug: string | null;
  name: string;
  name_en?: string | null;
  description?: string | null;
  description_en?: string | null;
  descriptionCard?: string | null;
  descriptionCard_en?: string | null;
  tags?: string | null;
  greeting?: string | null;
  greeting_en?: string | null;
  scenario?: string | null;
  scenario_en?: string | null;
  publicMemory?: unknown;
  publicMemory_en?: unknown;
};

/** Only URLs that were public/indexable before or after a change may leave the server. */
export function indexNowChangeUrls(before: CharacterChange | null, current: CharacterChange | null): string[] {
  const slugs = new Set<string>();
  for (const card of [before, current]) {
    if (!card?.isPublic || !card.slug || !/^[a-z0-9-]+$/i.test(card.slug)) continue;
    if (isAdultCharacter([
      card.name, card.name_en, card.description, card.description_en, card.descriptionCard, card.descriptionCard_en,
      card.tags, card.greeting, card.greeting_en, card.scenario, card.scenario_en,
      memoryToText(card.publicMemory), memoryToText(card.publicMemory_en),
    ])) continue;
    slugs.add(card.slug);
  }
  if (!slugs.size) return [];
  return LOCALES.flatMap((locale) => [
    `https://${config.host}/${locale}`,
    `https://${config.host}/${locale}/genres`,
    ...[...slugs].map((slug) => `https://${config.host}/${locale}/character/${slug}`),
  ]);
}

/** Best-effort indexing notice after a successful write; never delays saving a card. */
export function scheduleIndexNowChange(before: CharacterChange | null, current: CharacterChange | null) {
  if (process.env.NODE_ENV !== "production") return;
  const urlList = indexNowChangeUrls(before, current);
  if (!urlList.length) return;
  const send = async () => {
    try {
      const response = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ...config, keyLocation: `https://${config.host}/${config.key}.txt`, urlList }),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      // No payloads, card content, access tokens or response bodies in diagnostics.
      if (!response.ok) errorLog("IndexNow", `Submission returned HTTP ${response.status}`);
    } catch {
      errorLog("IndexNow", "Submission unavailable; normal sitemap crawling remains enabled");
    }
  };
  try {
    after(send);
  } catch {
    // A notification must not turn a completed database write into a failed save.
    errorLog("IndexNow", "Background submission could not be scheduled");
  }
}
