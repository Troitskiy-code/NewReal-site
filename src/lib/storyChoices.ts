/**
 * Story choices: a character's reply often ends with numbered options ("1. Пойти в замок…").
 * The chat shows them as buttons; the text around the list stays as written.
 */

export type StoryChoicesSplit = {
  /** Text before the list (may be empty). */
  before: string;
  /** Option texts, without numbers and markdown emphasis. */
  choices: string[];
  /** Text after the list (may be empty). */
  after: string;
};

const ITEM = /^\s*(?:\*\*)?(\d{1,2})[.)](?:\*\*)?\s+(.+?)\s*$/;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;
const MAX_CHOICE_LENGTH = 240;
/** The list must close the reply: at most this many non-empty lines may follow it. */
const MAX_TRAILING_LINES = 4;

function cleanChoice(text: string): string {
  return text.replace(/\*\*/g, "").replace(/^\*(.*)\*$/, "$1").trim();
}

/** Finds the last numbered list 1..n near the end of a reply; null when there is none. */
export function splitStoryChoices(content: string): StoryChoicesSplit | null {
  const lines = content.split(/\r?\n/);
  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (ITEM.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;

  const trailing = lines.slice(end + 1).filter((line) => line.trim()).length;
  if (trailing > MAX_TRAILING_LINES) return null;

  // Walk up through the list; blank lines between items are allowed.
  const items: Array<{ line: number; number: number; text: string }> = [];
  for (let index = end; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = ITEM.exec(line);
    if (!match) break;
    items.unshift({ line: index, number: Number(match[1]), text: cleanChoice(match[2]) });
  }

  if (items.length < MIN_CHOICES || items.length > MAX_CHOICES) return null;
  if (items.some((item, index) => item.number !== index + 1)) return null;
  if (items.some((item) => !item.text || item.text.length > MAX_CHOICE_LENGTH)) return null;

  const first = items[0].line;
  return {
    before: lines.slice(0, first).join("\n").replace(/\s+$/, ""),
    choices: items.map((item) => item.text),
    after: lines.slice(end + 1).join("\n").replace(/^\s+/, ""),
  };
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

export function choiceNumeral(index: number): string {
  return ROMAN[index] ?? String(index + 1);
}
