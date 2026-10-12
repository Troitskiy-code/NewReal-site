"use client";

import { FaTimes } from "react-icons/fa";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CHARACTER_TAG_GROUPS,
  parseTagsString,
  removeTagFromString,
  toggleTagInString,
  characterTagLabel,
  characterTagSearchTerms,
  LEGACY_CHARACTER_TAGS,
  MAX_SELECTED_CHARACTER_TAGS,
} from "@/lib/characterTags";

type CharacterTagPickerProps = {
  value: string;
  onChange: (value: string) => void;
};

export default function CharacterTagPicker({ value, onChange }: CharacterTagPickerProps) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith("en");
  const [search, setSearch] = useState("");
  const selectedTags = parseTagsString(value);
  const selected = new Set(selectedTags);
  const label = (tag: string) => characterTagLabel(tag, i18n.language);
  const query = search.trim().toLocaleLowerCase();
  const groups = CHARACTER_TAG_GROUPS.map(group => ({ ...group, tags: group.tags.filter(tag =>
    !query || [tag, label(tag), ...characterTagSearchTerms(tag)].some(term => term.toLocaleLowerCase().includes(query)),
  ) })).filter(group => group.tags.length);

  return (
    <div>
      <p className="mb-3 text-xs leading-relaxed text-wd-text-secondary">
        {en ? "Choose up to 8 accurate tags to help readers find your story." : "Выберите до 8 точных тегов: они помогают найти вашу историю."}
        {" "}{selectedTags.length}/{MAX_SELECTED_CHARACTER_TAGS}
      </p>
      <input type="search" value={search} onChange={event => setSearch(event.target.value)}
        aria-label={en ? "Find a tag" : "Найти тег"} placeholder={en ? "Find a tag" : "Найти тег"}
        className="mb-4 min-h-10 w-full rounded-xl border border-wd-border bg-wd-card px-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary" />
      {selectedTags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-full bg-wd-secondary px-3 py-1 text-xs text-white"
            >
              {label(tag)}{LEGACY_CHARACTER_TAGS.includes(tag) ? (en ? " (legacy)" : " (прежний)") : ""}
              <button
                type="button"
                onClick={() => onChange(removeTagFromString(value, tag))}
                className="rounded-full p-0.5 transition-colors hover:bg-white/20"
                aria-label={en ? `Remove tag ${label(tag)}` : `Убрать тег ${label(tag)}`}
              >
                <FaTimes className="text-[10px]" />
              </button>
            </span>
          ))}
        </div>
      )}

      {groups.map((group, index) => (
        <details
          key={group.id}
          open={Boolean(query) || index < 2}
          className="mb-3 rounded-xl border border-wd-border bg-wd-card px-3 py-2"
        >
          <summary className="min-h-8 cursor-pointer text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary">
            {en ? group.labelEn : group.label}
            {group.tags.some(tag => selected.has(tag)) ? ` · ${group.tags.filter(tag => selected.has(tag)).length}` : ""}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {group.tags.map((tag) => {
              const isActive = selected.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onChange(toggleTagInString(value, tag))}
                  aria-pressed={isActive}
                  disabled={!isActive && selected.size >= MAX_SELECTED_CHARACTER_TAGS}
                  className={`min-h-9 rounded-full px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive
                      ? "bg-wd-secondary text-white"
                      : "border border-wd-border bg-wd-bg text-wd-text-secondary hover:text-white"
                  }`}
                >
                  {label(tag)}
                </button>
              );
            })}
          </div>
        </details>
      ))}
      {!groups.length && <p className="text-sm text-wd-text-secondary">{en ? "No matching tags" : "Подходящих тегов нет"}</p>}
    </div>
  );
}
