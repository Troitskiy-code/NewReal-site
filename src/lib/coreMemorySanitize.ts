import { infoLog } from "./logger";

const NO_DATA_RE = /данных недостаточно/i;
const RELATIONSHIP_EVENT_RE =
  /ключевые изменения|предлож(?:ил|ила|или)\s+начать\s+встречаться|признал(?:ся|ась|ись)\s+в\s+чувствах|заключил(?:и|а)?\s+договор|узнал(?:а|и)?\s+тайну|принял(?:а|и)?\s+важное\s+решение/i;

function canonicalSectionName(title: string): string {
  const stripped = title.replace(/\(.*?\)/g, "").trim();
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

export function parseCoreSections(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  return sections.map((section) => ({
    title: section.title,
    body: section.body.join("\n").trim(),
  }));
}

export function sanitizeCoreMemory(raw: string, options: { log?: boolean } = {}): string {
  const log = options.log !== false;
  const kept: string[] = [];

  for (const section of parseCoreSections(raw)) {
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

    kept.push(`## ${name}\n${lines.join("\n")}`);
  }

  return kept.join("\n\n").trim();
}
