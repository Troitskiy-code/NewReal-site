"use client";

import { FaTimes } from "react-icons/fa";
import {
  CHARACTER_TAG_GROUPS,
  parseTagsString,
  removeTagFromString,
  toggleTagInString,
} from "@/lib/characterTags";

type CharacterTagPickerProps = {
  value: string;
  onChange: (value: string) => void;
};

export default function CharacterTagPicker({ value, onChange }: CharacterTagPickerProps) {
  const selectedTags = parseTagsString(value);
  const selected = new Set(selectedTags);

  return (
    <div>
      {selectedTags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#6C63FF] px-3 py-1 text-xs text-white"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(removeTagFromString(value, tag))}
                className="rounded-full p-0.5 transition-colors hover:bg-white/20"
                aria-label={`Убрать тег ${tag}`}
              >
                <FaTimes className="text-[10px]" />
              </button>
            </span>
          ))}
        </div>
      )}

      {CHARACTER_TAG_GROUPS.map((group, index) => (
        <div
          key={group.id}
          className={`space-y-2 ${index < CHARACTER_TAG_GROUPS.length - 1 ? "mb-4" : ""}`}
        >
          <h4 className="text-sm font-bold text-white">{group.label}</h4>
          <div className="flex flex-wrap gap-2">
            {group.tags.map((tag) => {
              const isActive = selected.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onChange(toggleTagInString(value, tag))}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    isActive
                      ? "bg-[#6C63FF] text-white"
                      : "bg-[#2A2A2A] text-gray-300 hover:bg-[#3A3A3A] hover:text-white"
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
