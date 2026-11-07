// Word-list check for explicit text. It knows nothing about ads, so other features can reuse it.
// A list misses euphemisms and catches some innocent text, so callers decide what a hit costs them.

/** One of these words alone makes a text explicit. */
const STRONG_STEMS = [
  "секс", "трах", "порн", "минет", "оргазм", "эрекц", "вагин", "пенис", "клитор", "анальн", "оральн",
  "мастурб", "дроч", "шлюх", "пизд", "сиськ", "ху[йея]", "еба", "ебл", "ебу", "ебе", "выеб", "заеб", "уеб", "наеб", "отъеб",
  "sex", "fuck", "porn", "pussy", "blowjob", "orgasm", "nude",
];

/** Ordinary words in most contexts («член совета», «прижал к груди»): only two different ones count. */
const SOFT_STEMS = [
  "груд", "бедр", "ягодиц", "сосок", "соск", "член", "киск", "стон", "возбужд", "обнаж", "раздев", "постел",
  "ласкал", "ласкае", "ласкат", "голая", "голый", "голое", "голые", "голую", "голой", "белье",
  "breast", "naked", "moan", "lingerie",
];

const wordStart = (stem: string) => new RegExp(`(?<!\\p{L})${stem}`, "iu");
const STRONG = STRONG_STEMS.map(wordStart);
const SOFT = SOFT_STEMS.map(wordStart);
const SOFT_HITS_TO_BLOCK = 2;

export function isExplicitText(text: string): boolean {
  const normalized = text.replace(/ё/gi, "е");
  if (STRONG.some((pattern) => pattern.test(normalized))) return true;
  return SOFT.filter((pattern) => pattern.test(normalized)).length >= SOFT_HITS_TO_BLOCK;
}
