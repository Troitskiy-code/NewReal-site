import { ALL_CHARACTER_TAGS, MAX_SELECTED_CHARACTER_TAGS, canonicalCharacterTag } from "./characterTags";

// Deterministic checks for generated cards, derived from the 2026-10-14 paid batch
// acceptance. Safe defects are repaired in place; the rest become text feedback.
type Card = { name: string; description: string; descriptionCard: string; appearance: string; greeting: string;
  scenario: string; exampleDialogs: string; avatarPrompt: string; tags: string | null;
  rpConfig: Partial<Record<"motivations" | "speechStyle" | "relationships" | "world" | "narrativeRules" | "canonicalNotes", string>> };

const words = (text: string) => text.toLocaleLowerCase("ru").match(/\p{L}+/gu) ?? [];
const corpus = (card: Card) => [card.description, card.descriptionCard, card.scenario, card.greeting, card.rpConfig.world ?? ""].join("\n");

// Setting tags need textual support; an unsupported tag is dropped, not paid for again.
const ACADEMY = /академи|школ|университет|училищ|институт|студент|ученик|ученица|адепт|первокурс|выпускни|ректор|преподавател/iu;
const MODERN = /телефон|смартфон|ноутбук|компьютер|интернет|автомобил|такси|метро|офис|кафе|кофейн|перестрел|пистолет|револьвер|самол[её]т|аэропорт|соцсет|онлайн|мотоцикл|небоскр[её]б|корпорац|мафи/iu;

export function normalizeGeneratedTags(raw: unknown, card: Pick<Card, "description" | "descriptionCard" | "scenario" | "greeting" | "rpConfig">) {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const text = corpus(card as Card), dropped: string[] = [];
  const tags = [...new Set(values.filter((value): value is string => typeof value === "string")
    .map(value => canonicalCharacterTag(value)).filter((tag): tag is string => Boolean(tag) && ALL_CHARACTER_TAGS.includes(tag!)))]
    .filter(tag => {
      const unsupported = tag === "Магическая академия" && !ACADEMY.test(text) || tag === "Средневековье" && MODERN.test(text);
      if (unsupported) dropped.push(tag);
      return !unsupported;
    }).slice(0, MAX_SELECTED_CHARACTER_TAGS);
  return { tags, dropped };
}

/** Speaker labels: "{{char}} —" and "Имя:" become "{{char}}:" so the chat prompt keeps roles. */
export function normalizeDialogMarkers(dialogs: string, name: string) {
  const names = [...new Set([name.trim(), name.trim().split(/\s+/)[0]])].filter(Boolean)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // "Софья (смотрит): …" and "{{char}} (тихо): …" keep the stage direction after the label.
  return dialogs.replace(/^(\s*)\{\{(user|char)\}\}\s*[—–-]\s*/gimu, "$1{{$2}}: ")
    .replace(new RegExp(`^(\\s*)(?:${names.join("|")}|\\{\\{(?:char)\\}\\})\\s*(\\([^)\\n]{1,80}\\))\\s*:\\s*`, "gimu"), "$1{{char}}: $2 ")
    .replace(/^(\s*)\{\{user\}\}\s*(\([^)\n]{1,80}\))\s*:\s*/gimu, "$1{{user}}: $2 ")
    .replace(new RegExp(`^(\\s*)(?:${names.join("|")})\\s*:\\s*`, "gimu"), "$1{{char}}: ");
}

const COLOR_FAMILIES: Array<[RegExp, string[]]> = [
  [/^(т[её]мн|dark)/, ["dark", "brown", "black"]],
  [/^(светл|light|pale)/, ["light", "blond", "blue", "grey", "green"]],
  [/^(серо$|сер(ый|ая|ое|ые|ого|ых|ым|ыми|ую|ой)$|стальн|пепельн|grey|gray|steel|ash)/, ["grey"]],
  [/^(кари|карие|карих|карими|карим|карего|коричнев|ореховы|каштанов|шатен|brown|hazel|chestnut)/, ["brown", "dark"]],
  [/^(зел[её]н|изумрудн|green|emerald)/, ["green"]],
  [/^(син|голуб|лазурн|васильков|blue|azure)/, ["blue"]],
  [/^(ч[её]рн|смолян|воронов|black|raven|jet)/, ["black", "dark"]],
  [/^(золот|янтарн|медов|gold|amber|honey)/, ["gold"]],
  [/^(красн|багров|алы|рыж|red|crimson|scarlet|ginger|auburn|copper)/, ["red"]],
  [/^(фиолет|лилов|аметист|violet|purple|lilac)/, ["violet"]],
  [/^(серебр|бел|сед|платин|silver|white|platinum)/, ["silver"]],
  [/^(блонд|русы|рус(ые|ая|ыми)$|пшенич|blond|fair)/, ["blond", "light", "brown"]],
];
const ANCHORS = { eyes: /^(глаз|взгляд|радужк|eyes?$|iris|gaze$)/, hair: /^(волос|кос(а|у|ой|ы)$|шевелюр|прич[её]ск|локон|пряд|hair$|braid|locks$|curls$|ponytail$)/ };

function colors(text: string, part: keyof typeof ANCHORS) {
  const other = part === "eyes" ? ANCHORS.hair : ANCHORS.eyes, found = new Set<string>();
  for (const clause of text.split(/[.;!?\n]/)) {
    const tokens = words(clause);
    tokens.forEach((token, index) => {
      if (!ANCHORS[part].test(token)) return;
      for (const direction of [-1, 1]) for (let step = 1; step <= 3; step++) {
        const near = tokens[index + direction * step];
        if (!near || other.test(near)) break;
        for (const [pattern, families] of COLOR_FAMILIES) if (pattern.test(near)) families.forEach(family => found.add(family));
      }
    });
  }
  return found;
}

const GENDERED = /^(\p{L}{2,}(л|ла|лась|лся)|сам|сама|уверен|уверена|готов|готова|прав|права|должен|должна|рад|рада|один|одна|согласен|согласна|свободен|свободна|обязан|обязана|влюбл[её]н|влюблена|способен|способна)$/u;
const NOT_VERBS = new Set(["идеал", "ангел", "стол", "пол", "зал", "угол", "сила", "дела", "тела", "стрела", "скала", "игла", "мгла", "пчела", "метла"]);
const PARTICLES = new Set(["бы", "же", "ведь", "уже", "уж", "не", "ни", "просто", "тоже", "так", "и", "ещё", "еще", "всё", "все", "правда",
  "точно", "действительно", "вообще", "только", "сегодня", "вчера", "сейчас", "давно", "никогда", "всегда", "тогда", "там", "тут", "здесь", "сразу", "почти"]);

/** Fragments that fix the user's gender: "ты ворвалась", "{{user}}: я был там". */
export function userGenderFragments(card: Pick<Card, "greeting" | "exampleDialogs">) {
  const found: string[] = [];
  const scan = (text: string, pronoun: string) => {
    const tokens = words(text);
    tokens.forEach((token, index) => {
      if (token !== pronoun) return;
      // Only the word right after the pronoun, or after one particle: "я просто нашёл".
      const next = PARTICLES.has(tokens[index + 1]) ? tokens[index + 2] : tokens[index + 1];
      const hit = next && GENDERED.test(next) && !NOT_VERBS.has(next) ? next : null;
      if (hit && found.length < 3) found.push(`${pronoun} … ${hit}`);
    });
  };
  scan(card.greeting.replace(/\{\{user\}\}/g, ""), "ты");
  for (const line of card.exampleDialogs.split("\n")) {
    if (/^\s*\{\{char\}\}/i.test(line)) scan(line, "ты");
    else if (/^\s*\{\{user\}\}/i.test(line)) scan(line, "я");
  }
  return found;
}

const PLACEHOLDER = /\[[^\]\n]{0,40}\]|\{\{(?!user\}\}|char\}\})[^}\n]{0,30}\}\}|<\s*(имя|name)[^>]*>|\b(TODO|XXX|Lorem)\b/iu;
const IMAGE_JARGON = /высококачествен|гиперреалист|фотореалист|(?<![\p{L}\d])[48]k(?![\p{L}\d])|hyperrealistic|photorealistic|masterpiece|best quality|ultra[- ]?detailed|cinematic lighting/iu;
const REPEAT = /(?<!\p{L})(\p{L}{4,})[\s,;:—–-]+\1(?!\p{L})/iu;
export const ruYears = (age: number) => `${age} ${age % 10 === 1 && age % 100 !== 11 ? "год"
  : age % 10 >= 2 && age % 10 <= 4 && (age % 100 < 12 || age % 100 > 14) ? "года" : "лет"}`;
const ageMention = (age: number) => new RegExp(`(?<!\\d)${age}\\s*(год|года|лет)(?!\\p{L})`, "u");

/** Every issue is phrased as a correction for the next text attempt. */
export function cardQualityIssues(card: Card, theme?: { age?: unknown }) {
  const issues: string[] = [];
  const prose: Array<[string, string]> = [["description", card.description], ["descriptionCard", card.descriptionCard],
    ["appearance", card.appearance], ["greeting", card.greeting], ["scenario", card.scenario], ["exampleDialogs", card.exampleDialogs],
    ...Object.entries(card.rpConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [`rpConfig.${key}`, value] as [string, string])];
  const placeholder = [...prose, ["avatarPrompt", card.avatarPrompt] as [string, string]].find(([, text]) => PLACEHOLDER.test(text));
  if (placeholder) issues.push(`Убери заглушку «${placeholder[1].match(PLACEHOLDER)![0]}» из ${placeholder[0]}: нужен законченный текст.`);
  const jargon = prose.find(([, text]) => IMAGE_JARGON.test(text));
  if (jargon) issues.push(`Слова о качестве изображения («${jargon[1].match(IMAGE_JARGON)![0]}») допустимы только в avatarPrompt, убери их из ${jargon[0]}.`);
  const repeat = prose.filter(([key]) => key !== "exampleDialogs" && key !== "greeting").find(([, text]) => REPEAT.test(text));
  if (repeat) issues.push(`Повтор слова «${repeat[1].match(REPEAT)![0]}» в ${repeat[0]}.`);
  const userLines = card.exampleDialogs.match(/^\s*\{\{user\}\}:/gim)?.length ?? 0, charLines = card.exampleDialogs.match(/^\s*\{\{char\}\}:/gim)?.length ?? 0;
  if (userLines < 2 || charLines < 2) issues.push("В exampleDialogs каждая реплика начинается с «{{user}}:» или «{{char}}:», минимум по две реплики каждого.");
  const canonAge = card.rpConfig.canonicalNotes?.match(/^\s*Возраст:\s*([^.\n]+)/iu)?.[1];
  if (!canonAge) issues.push("rpConfig.canonicalNotes должно начинаться со строки «Возраст: N.»");
  if (typeof theme?.age === "number") {
    if (canonAge && !new RegExp(`(?<!\\d)${theme.age}(?!\\d)`).test(canonAge))
      issues.push(`Возраст персонажа — ${theme.age}; исправь первую строку canonicalNotes.`);
    if (!ageMention(theme.age).test(card.appearance)) issues.push(`Во внешности укажи возраст цифрами: «${ruYears(theme.age)}».`);
  }
  for (const part of ["eyes", "hair"] as const) {
    const ru = colors(card.appearance, part), avatar = colors(card.avatarPrompt, part);
    if (ru.size && avatar.size && ![...ru].some(value => avatar.has(value)))
      issues.push(part === "eyes" ? "Цвет глаз во внешности и в avatarPrompt различается; сделай одинаковым." : "Цвет волос во внешности и в avatarPrompt различается; сделай одинаковым.");
  }
  const gendered = userGenderFragments(card);
  if (gendered.length) issues.push(`Не задавай пол пользователя (${gendered.join("; ")}): используй «вы», настоящее время или нейтральные формы.`);
  return issues;
}

// ---- Avatar prompt -------------------------------------------------------------

// The card's avatarPrompt is passed as "requested details, which take priority": a leftover
// "photorealistic" would override an anime theme, and "dimly lit, muted tones" made the 2026-10-14/15
// avatars gloomy. The style line comes from the theme instead.
const STYLE_AND_GLOOM = /\b(?:hyper-?realistic|photo-?realistic|realistic(?:\s+(?:fantasy\s+)?style|\s+textures?)?|dark(?=\s*(?:,|\.|$))|(?:professional\s+)?photograph(?:y|ic)|cinematic(?:\s+lighting)?|anime(?:\s+style)?|manga\s+style|cel[- ]shad\w*|\d+k(?:\s+(?:resolution|detail))?|ultra[- ]detailed|hyper-detailed(?:\s+textures)?|high\s+detail|muted\s+tones|dim(?:ly)?\s+lit|dim\s+light(?:ing)?|low[- ]light|darkened|shadowy|(?:casts?\s+)?long\s+shadows|gloomy|moody|melancholic)\b/gi;

export function cleanAvatarPrompt(prompt: string) {
  return prompt.replace(STYLE_AND_GLOOM, "").replace(/\s+([,.])/g, "$1").replace(/([,.])(?:\s*[,.])+/g, "$1")
    .replace(/\s{2,}/g, " ").replace(/^[\s,.]+|[\s,]+$/g, "").trim();
}

// ---- English translation -------------------------------------------------------

const TRANSLIT: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

/** Names are transliterated, never translated: Yandex turned «Руна Север» into "The North Rune". */
export function transliterateName(name: string) {
  return name.replace(/\p{L}+/gu, word => {
    const upper = word.length > 1 && word === word.toLocaleUpperCase("ru");
    const latin = Array.from(word.toLocaleLowerCase("ru")).map((char, index, chars) =>
      char === "е" && (chars[index - 1] === "ь" || chars[index - 1] === "ъ") ? "ye" : TRANSLIT[char] ?? char).join("");
    return upper ? latin.toUpperCase() : word[0] === word[0].toLocaleLowerCase("ru") ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces every inflected form of the name with a Latin token before translation and puts the
 * transliterated name back afterwards, so a name that is also a word (Руна, Север, Лесной) survives.
 */
export function protectName(text: string, name: string) {
  const parts = [...new Set(name.match(/\p{L}{3,}/gu) ?? [])].filter(part => /[А-Яа-яЁё]/.test(part));
  let protectedText = text, inserted = 0;
  const tokens = parts.map((part, index) => {
    // Case endings of names are at most two letters (Руны, Лесного, Костровым); a longer tail is
    // another word with the same root (Северный).
    const stem = part.length >= 4 ? part.replace(/[аеёиоуыэюяйь]$/iu, "") : part;
    const pattern = new RegExp(`(?<!\\p{L})${escapeRegExp(stem)}\\p{Ll}{0,2}(?!\\p{L})`, "gu");
    protectedText = protectedText.replace(pattern, () => { inserted++; return `ZXQ${index}`; });
    return transliterateName(part);
  });
  return {
    text: protectedText,
    /** False when the translator dropped or mangled a token; the caller then translates the plain text. */
    intact: (translated: string) => (translated.match(/zxq\s*\d/gi)?.length ?? 0) === inserted,
    restore: (translated: string) => translated
      .replace(/\b(?:the|a|an)\s+(?=zxq\s*\d)/gi, "")
      .replace(/zxq\s*(\d)/gi, (match, digit: string) => tokens[Number(digit)] ?? match),
  };
}

const PRONOUNS = {
  male: { She: "He", she: "he", Her: "His", her: "his", hers: "his", herself: "himself", Herself: "Himself" },
  female: { He: "She", he: "she", His: "Her", his: "her", him: "her", himself: "herself", Himself: "Herself" },
} as const;

export function characterGender(card: Pick<Card, "tags" | "appearance">): "male" | "female" | null {
  const tags = card.tags ?? "";
  if (tags.includes("Мужской персонаж")) return "male";
  if (tags.includes("Женский персонаж")) return "female";
  const first = card.appearance.slice(0, 120);
  if (/(?<!\p{L})(мужчин|парен|юнош|старик)/iu.test(first)) return "male";
  if (/(?<!\p{L})(женщин|девушк|старушк)/iu.test(first)) return "female";
  // No tag and no noun («Рэн Асаи, 41 год…»): the appearance speaks about the character, so its
  // pronouns decide («На нём…», «Он держится…»), unless both genders appear.
  const count = (pattern: RegExp) => card.appearance.match(new RegExp(pattern.source, "giu"))?.length ?? 0;
  const male = count(MALE_RU), female = count(FEMALE_RU);
  if (male > 0 && female === 0 || male >= 2 && male >= female * 3) return "male";
  if (female > 0 && male === 0 || female >= 2 && female >= male * 3) return "female";
  return null;
}

/**
 * The appearance describes only the character, but Russian drops the subject and Yandex guesses it
 * ("Her eyes", "your left arm", "I always have"). Without another person in the source, fix the guess.
 */
export function fixAppearancePronouns(english: string, source: string, gender: "male" | "female" | null) {
  if (!gender) return english;
  const other = gender === "male" ? FEMALE_RU : MALE_RU;
  let text = english;
  if (!other.test(source)) {
    const map: Record<string, string> = PRONOUNS[gender];
    text = text.replace(new RegExp(`\\b(${Object.keys(map).join("|")})\\b`, "g"), word => map[word]);
  }
  const subject = gender === "male" ? "He" : "She", possessive = gender === "male" ? "his" : "her";
  // "your" only comes from a possessive (ваш, твой); «к вам» legitimately gives "you".
  if (!/(?<!\p{L})(ваш\p{L}*|тво\p{L}*)(?!\p{L})/iu.test(source))
    text = text.replace(/\bYour\b/g, possessive[0].toUpperCase() + possessive.slice(1)).replace(/\byour\b/g, possessive);
  if (!/(?<!\p{L})(я|мне|меня|мой|моя|моё|мои)(?!\p{L})/iu.test(source))
    text = text.replace(/\bI (always |usually |often )?(have|carry|wear|keep)\b/g, (_match, adverb: string | undefined, verb: string) =>
      `${subject} ${adverb ?? ""}${verb === "have" ? "has" : `${verb}s`}`);
  return text;
}

// ---- English translation checks -------------------------------------------------

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/** Field-by-field translation spells names differently (Sylvan Ray / Silvan Rey); keep the name_en spelling. */
export function alignNameTranslation(text: string, nameEn: string | undefined) {
  if (!nameEn) return text;
  const parts = [...new Set(nameEn.match(/[A-Za-z]{3,}/g) ?? [])];
  return text.replace(/(?<![A-Za-z])[A-Z][a-z]{2,}(?![A-Za-z])/g, word => {
    const target = parts.find(part => part !== word && part[0] === word[0]
      && distance(part.toLowerCase(), word.toLowerCase()) <= Math.max(1, Math.floor(part.length / 4)));
    return target ?? word;
  });
}

const FEMALE_RU = /(?<!\p{L})(она|её|ее|ей|неё|нее|ней)(?!\p{L})/iu, MALE_RU = /(?<!\p{L})(он|его|ему|него|нему|ним|нём|нем)(?!\p{L})/iu;
const FEMALE_EN = /\b(she|her|hers|herself)\b/i, MALE_EN = /\b(he|him|his|himself)\b/i;

/** Non-blocking warnings for the editor: draft text is saved, a person decides. */
export function translationWarnings(card: Card | null, translations: Record<string, string> | null) {
  if (!card || !translations) return [];
  const warnings: string[] = [];
  const gender = characterGender(card);
  for (const field of ["description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs"] as const) {
    const source = card[field], english = translations[`${field}_en`];
    if (!source || !english) continue;
    const missing = [...new Set(source.match(/(?<!\d)\d{2,4}(?!\d)/g) ?? [])].filter(number => !english.includes(number));
    if (missing.length) warnings.push(`${field}_en: нет чисел ${missing.join(", ")} из оригинала (проверьте возраст и сроки).`);
    if (field === "appearance" || field === "description") {
      if (gender === "male" && FEMALE_EN.test(english) && !FEMALE_RU.test(source)) warnings.push(`${field}_en: женские местоимения у мужского персонажа.`);
      if (gender === "female" && MALE_EN.test(english) && !MALE_RU.test(source)) warnings.push(`${field}_en: мужские местоимения у женского персонажа.`);
    }
  }
  const dialogs = translations.exampleDialogs_en;
  if (dialogs && ["{{user}}", "{{char}}"].some(marker => dialogs.split(marker).length !== card.exampleDialogs.split(marker).length))
    warnings.push("exampleDialogs_en: маркеры {{user}} / {{char}} не совпадают с оригиналом.");
  return warnings;
}
