import { infoLog } from "./logger";
import { stripMemoryControlInstructions } from "./memorySafety";

const NO_DATA_RE = /данных недостаточно/i;
const RELATIONSHIP_EVENT_RE =
  /ключевые изменения|предлож(?:ил|ила|или)\s+начать\s+встречаться|признал(?:ся|ась|ись)\s+в\s+чувствах|заключил(?:и|а)?\s+договор|узнал(?:а|и)?\s+тайну|принял(?:а|и)?\s+важное\s+решение/i;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const CORE_MEMORY_MAX_CHARS = 6000;
const NOTES_SECTION = "Заметки";

function canonicalSectionName(title: string): string {
  const stripped = title.replace(/\(.*?\)/g, "").trim();
  if (!stripped) return NOTES_SECTION;
  if (/^персонаж/i.test(stripped)) return "Персонаж";
  if (/^пользовател/i.test(stripped)) return "Пользователь";
  if (/^отношен/i.test(stripped)) return "Отношения";
  return stripped;
}

function isRelationshipSection(title: string): boolean {
  return canonicalSectionName(title) === "Отношения";
}

function isNoDataLine(line: string): boolean {
  const stripped = line.replace(/^[-*•\d.)\s]+/, "").trim();
  if (!stripped) return true;
  return NO_DATA_RE.test(stripped);
}

function isRelationshipEventLine(line: string): boolean {
  return RELATIONSHIP_EVENT_RE.test(line);
}

/** Text before the first heading is returned as an untitled section instead of being dropped. */
export function parseCoreSections(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } = { title: "", body: [] };

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      sections.push(current);
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    current.body.push(line);
  }
  sections.push(current);

  return sections
    .map((section) => ({ title: section.title, body: section.body.join("\n").trim() }))
    .filter((section) => section.title || section.body);
}

export function sanitizeCoreMemory(raw: string, options: { log?: boolean } = {}): string {
  const log = options.log !== false;
  const kept = new Map<string, string[]>();

  for (const section of parseCoreSections(stripMemoryControlInstructions(raw.replace(CONTROL_CHARS_RE, "")))) {
    const name = canonicalSectionName(section.title);
    let lines = section.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !isNoDataLine(line));

    if (isRelationshipSection(section.title)) {
      lines = lines.filter((line) => !isRelationshipEventLine(line));
    }

    if (lines.length === 0) {
      if (log) infoLog("Memory:Core", `Skipped section "${name}" (no data)`);
      continue;
    }

    kept.set(name, [...(kept.get(name) ?? []), ...lines]);
  }

  return [...kept.entries()]
    .map(([name, lines]) => `## ${name}\n${lines.join("\n")}`)
    .join("\n\n")
    .trim();
}

/** Manual edits use the same normalization as reads, so the editor shows exactly what the chat will use. */
export function normalizeManualCoreMemory(raw: string): string {
  return sanitizeCoreMemory(raw.slice(0, CORE_MEMORY_MAX_CHARS), { log: false });
}

/** Background extraction may add facts, but only an explicit editor save may remove them. */
export function mergeCoreMemoryFacts(previous: string, proposed: string): string {
  const original = sanitizeCoreMemory(previous, { log: false });
  const sections = new Map(parseCoreSections(original).map(({ title, body }) => [title, body.split("\n")]));
  const key = (line: string) => line.normalize("NFKC").replace(/^[-*•\s]+/, "").trim().toLocaleLowerCase();
  const seen = new Set([...sections.values()].flat().map(key));
  const render = () => [...sections].map(([title, lines]) => `## ${title}\n${lines.join("\n")}`).join("\n\n");
  for (const { title, body } of parseCoreSections(sanitizeCoreMemory(proposed, { log: false }))) {
    for (const line of body.split("\n")) {
      if (seen.has(key(line))) continue;
      const lines = sections.get(title) ?? [];
      sections.set(title, [...lines, line]);
      if (render().length > CORE_MEMORY_MAX_CHARS) {
        if (lines.length) sections.set(title, lines);
        else sections.delete(title);
        continue;
      }
      seen.add(key(line));
    }
  }
  return render();
}
