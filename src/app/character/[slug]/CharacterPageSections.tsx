import LocaleLink from "@/components/LocaleLink";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { pickLocalizedText } from "@/lib/characterFields";
import { pickFeaturedGenre } from "@/lib/characterTags";
import { translate } from "@/lib/getDictionary";
import { getAnonymousMessageLimit } from "@/lib/anonymousSession";
import { FREE_DAILY_REPLIES, FREE_DAILY_REPLIES_ONBOARDING } from "@/lib/freeDailyQuota";
import { isFreeDailyQuotaEnabled } from "@/lib/freeDailyQuotaServer";
import { isEnglishLocale } from "@/lib/i18nConfig";
import { STORY_GREETING_MAX, STORY_SCENARIO_MAX, storyExcerpt } from "@/lib/characterSeoContent";
import type { getSimilarCharacters } from "@/lib/characterPageData";

// Server-rendered page text: it reaches crawlers in the HTML and never ships in the client bundle.

type Story = { greeting: string | null; greeting_en: string | null; scenario: string | null; scenario_en: string | null };

/** The localized field, or the original when the card has no translation (as in the chat itself). */
function localizedStory(original: string | null, translated: string | null, locale: string) {
  return isEnglishLocale(locale) && translated?.trim() ? translated : original;
}

export function CharacterStory({ story, name, locale }: { story: Story; name: string; locale: string }) {
  const storyLocale = isEnglishLocale(locale) ? "en" : "ru";
  const scenario = storyExcerpt(localizedStory(story.scenario, story.scenario_en, locale), name, storyLocale, STORY_SCENARIO_MAX);
  const greeting = storyExcerpt(localizedStory(story.greeting, story.greeting_en, locale), name, storyLocale, STORY_GREETING_MAX);
  if (!scenario && !greeting) return null;
  return (
    <>
      {scenario ? (
        <section aria-labelledby="character-scenario" className="rounded-2xl bg-wd-elevated p-4">
          <h2 id="character-scenario" className="text-[11px] font-bold uppercase tracking-[0.1em] text-wd-secondary">
            {translate(locale, "characterPage.scenario")}
          </h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-200">{scenario}</p>
        </section>
      ) : null}
      {greeting ? (
        <section aria-labelledby="character-story-start" className="rounded-2xl bg-wd-elevated p-4">
          <h2 id="character-story-start" className="text-[11px] font-bold uppercase tracking-[0.1em] text-wd-secondary">
            {translate(locale, "characterPage.storyStart")}
          </h2>
          <blockquote className="mt-2 whitespace-pre-line border-l-2 border-wd-primary/50 pl-3 text-sm italic leading-relaxed text-gray-200">
            {greeting}
          </blockquote>
        </section>
      ) : null}
    </>
  );
}

type SimilarCard = Awaited<ReturnType<typeof getSimilarCharacters>>[number];

/** Name and genre only: other characters' descriptions would repeat their own pages here. */
export function SimilarCharacters({ characters, locale }: { characters: SimilarCard[]; locale: string }) {
  if (characters.length === 0) return null;
  return (
    <section aria-labelledby="similar-characters" className="space-y-3">
      <h2 id="similar-characters" className="font-display text-lg font-semibold text-white">
        {translate(locale, "characterPage.similar")}
      </h2>
      <ul className="grid grid-cols-2 gap-2 sm:gap-3">
        {characters.map((character) => {
          const genre = pickFeaturedGenre(character.tags);
          return (
            <li key={character.id} className="min-w-0">
              <LocaleLink href={`/character/${character.slug}`}
                className="flex min-w-0 items-center gap-3 rounded-2xl border border-wd-border bg-wd-card p-2 transition-colors hover:border-wd-secondary">
                <img src={characterAvatarPath(character.id, character.updatedAt)} alt="" loading="lazy" decoding="async" width={48} height={64}
                  className="h-16 w-12 shrink-0 rounded-xl bg-wd-elevated object-cover object-[center_22%]" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-white">
                    {pickLocalizedText(character.name, character.name_en, locale) ?? character.name}
                  </span>
                  {genre ? (
                    <span className="block truncate text-xs text-wd-text-secondary">{translate(locale, `home.genres.${genre.id}`)}</span>
                  ) : null}
                </span>
              </LocaleLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function messagesWord(locale: string, count: number): string {
  const form = new Intl.PluralRules(isEnglishLocale(locale) ? "en" : "ru").select(count);
  return translate(locale, `characterPage.messagesWord.${form === "one" || form === "few" ? form : "many"}`);
}

export function characterFaq(locale: string, name: string) {
  const limit = getAnonymousMessageLimit();
  const vars = {
    name, limit, messages: messagesWord(locale, limit),
    onboarding: FREE_DAILY_REPLIES_ONBOARDING, daily: FREE_DAILY_REPLIES,
  };
  return (["free", "register", "language", "start"] as const).map((key) => ({
    question: translate(locale, `characterPage.faq.${key}Q`, vars),
    answer: translate(locale, `characterPage.faq.${key === "free" && !isFreeDailyQuotaEnabled() ? "freeAPaid" : `${key}A`}`, vars),
  }));
}

export function CharacterFaq({ items, locale }: { items: ReturnType<typeof characterFaq>; locale: string }) {
  return (
    <section aria-labelledby="character-faq" className="space-y-3">
      <h2 id="character-faq" className="font-display text-lg font-semibold text-white">
        {translate(locale, "characterPage.faq.title")}
      </h2>
      <dl className="space-y-2">
        {items.map((item) => (
          <div key={item.question} className="rounded-2xl border border-wd-border bg-wd-card p-4">
            <dt className="text-sm font-semibold text-white">{item.question}</dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-wd-text/80">{item.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
