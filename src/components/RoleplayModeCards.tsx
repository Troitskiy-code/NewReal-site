"use client";

import Image from "next/image";
import LocaleLink from "@/components/LocaleLink";
import { MAX_GROUP_PARTICIPANTS, ROLEPLAY_MODES, ROLEPLAY_MODE_LABELS, type RoleplayMode } from "@/lib/roleplayConfig";

const ART: Record<RoleplayMode, { image: string; hint: string }> = {
  character: { image: "single-character.png", hint: "Один герой со своим характером и голосом." },
  world: { image: "universe.png", hint: "Мир, события и действующие лица. Вы — главный герой." },
  group: { image: "multiple-characters.png", hint: `Общая история с составом до ${MAX_GROUP_PARTICIPANTS} персонажей.` },
};

export default function RoleplayModeCards({ selected, onSelect }: {
  selected?: RoleplayMode;
  onSelect?: (mode: RoleplayMode) => void;
}) {
  return <div className="@container"><div className="grid gap-4 @3xl:grid-cols-3">
    {ROLEPLAY_MODES.map(mode => {
      const active = selected === mode;
      const classes = `group relative block aspect-[4/3] overflow-hidden rounded-2xl border-2 bg-[#0A0A0A] text-left shadow-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#B9AEFF] ${active ? "border-[#B9AEFF] ring-2 ring-[#6C63FF]/30" : "border-[#2A2A2A] hover:border-[#B9AEFF]"}`;
      const content = <>
        <Image src={`/images/roleplay-modes-v1/${ART[mode].image}`} alt="" fill sizes="(max-width: 1024px) 100vw, (max-width: 1200px) 33vw, 380px" className="object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.03]" />
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />
        {active && <span aria-hidden="true" className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-[#6C63FF] text-white">✓</span>}
        <span className="absolute inset-x-0 bottom-0 space-y-2 p-4 sm:p-5">
          <span className="block text-xl font-bold leading-tight text-white">{ROLEPLAY_MODE_LABELS[mode]}</span>
          <span className="block text-sm leading-relaxed text-gray-200">{ART[mode].hint}</span>
        </span>
      </>;
      return onSelect
        ? <button key={mode} type="button" aria-label={ROLEPLAY_MODE_LABELS[mode]} aria-pressed={active} className={classes} onClick={() => onSelect(mode)}>{content}</button>
        : <LocaleLink key={mode} href={`/create/${mode}`} prefetch={false} aria-label={ROLEPLAY_MODE_LABELS[mode]} className={classes}>{content}</LocaleLink>;
    })}
  </div></div>;
}
