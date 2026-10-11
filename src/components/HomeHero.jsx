"use client";

import { useTranslation } from "react-i18next";
import LocaleLink from "./LocaleLink";
import { characterAvatarPath } from "@/lib/characterCardImage";

const COLLAGE_POSITIONS = [
  "left-[4%] top-9 -rotate-6",
  "left-1/2 top-0 z-10 h-56 w-[10.5rem] -translate-x-1/2",
  "right-[4%] top-10 rotate-6",
];

export default function HomeHero({ total, characters }) {
  const { t } = useTranslation();
  const collage = characters.slice(0, 3);

  return (
    <section className="px-4 pt-4 md:px-6 md:pt-6">
      <div className="relative grid overflow-hidden rounded-3xl border border-white/10 bg-[#111] bg-[radial-gradient(700px_280px_at_85%_0%,rgba(91,84,230,0.3),transparent_60%),radial-gradient(560px_280px_at_0%_100%,rgba(225,29,72,0.22),transparent_60%)] px-5 py-6 md:px-10 md:py-9 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-6">
        <div>
          <h1>
            <span className="mb-3 block text-xs font-bold uppercase tracking-[0.08em] text-wd-secondary-text">
              {t("home.hero.eyebrow")}
            </span>
            <span className="block text-balance text-[26px] font-extrabold leading-[1.1] tracking-tight text-white md:text-[40px]">
              {t("home.hero.title")}
            </span>
          </h1>
          <p className="mt-3 line-clamp-2 max-w-xl text-[15px] leading-relaxed text-wd-text-secondary md:mt-4 md:line-clamp-none md:text-base">
            {t("home.hero.text")}
          </p>
          <div className="mt-5 flex flex-wrap gap-3 md:mt-6">
            <a
              href="#catalog"
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-full bg-wd-primary px-6 text-[15px] font-semibold text-white transition-colors hover:bg-wd-primary-hover sm:flex-none"
            >
              {t("home.hero.start")}
            </a>
            <LocaleLink
              href="/create"
              className="hidden min-h-12 items-center justify-center rounded-full border border-white/20 px-6 text-[15px] font-semibold text-white transition-colors hover:border-white/40 hover:bg-white/5 sm:inline-flex"
            >
              {t("home.hero.create")}
            </LocaleLink>
          </div>
          <p className="mt-5 hidden gap-5 text-[13px] text-wd-text-secondary md:flex">
            <span>{t("home.hero.catalogCount", { count: total })}</span>
            <span>{t("home.hero.languages")}</span>
          </p>
        </div>

        {collage.length === 3 && (
          <div aria-hidden className="relative hidden h-60 lg:block">
            {collage.map((character, index) => (
              <img
                key={character.id}
                src={characterAvatarPath(character.id, character.updatedAt)}
                alt=""
                loading="lazy"
                className={`absolute h-48 w-36 rounded-2xl border-2 border-white/15 object-cover object-[center_25%] shadow-[0_20px_40px_rgba(0,0,0,0.6)] ${COLLAGE_POSITIONS[index]}`}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
