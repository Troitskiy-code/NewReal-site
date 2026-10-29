import { createHash } from "node:crypto";

const protectedText = /\{\{[^{}]+\}\}|<\/?[^>]+>|https?:\/\/[^\s<>]+|\b(?:NewVerse|VerseCoins|Robokassa|Stripe|VC|Yandex|Telegram|Google)\b|\r?\n/g;
const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function protectTranslation(text) {
  const tokens = [];
  let result = "", end = 0;
  for (const match of text.matchAll(protectedText)) {
    result += escapeHtml(text.slice(end, match.index));
    const index = tokens.push(match[0]) - 1;
    result += `<span translate="no">__NV_KEEP_${index}__</span>`;
    end = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(end));
  return { text: result, tokens };
}
export function restoreTranslation(text, tokens) {
  let result = text.replace(/<\/?span\b[^>]*>/gi, "");
  const counts = tokens.map(() => 0);
  result = result.replace(/__NV_KEEP_(\d+)__/g, (_, rawIndex) => {
    const index = Number(rawIndex);
    if (index >= tokens.length) throw new Error("Unexpected protected token");
    counts[index]++;
    return `\uE000${index}\uE001`;
  });
  if (counts.some(count => count !== 1) || /__NV_KEEP_/.test(result)) throw new Error("Translation changed protected markup or variables");
  result = result.replace(/&(?:#x([a-f0-9]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi, (_, hex, number, name) => hex ? String.fromCodePoint(parseInt(hex, 16)) : number ? String.fromCodePoint(Number(number)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" })[name.toLowerCase()]);
  return result.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)]);
}
export function splitTranslationText(text, limit = 1400) {
  const pieces = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf("\n", limit);
    if (end < limit / 2) end = rest.lastIndexOf(" ", limit);
    if (end < limit / 2) end = limit;
    // Never split a template variable or markup token across requests.
    const open = rest.lastIndexOf("{{", end), close = rest.lastIndexOf("}}", end);
    if (open > close) end = open || rest.indexOf("}}", end) + 2;
    if (end <= 0) throw new Error("Unable to split source text");
    pieces.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) pieces.push(rest);
  return pieces;
}
export const translationKey = (text, locale, source) => createHash("sha256").update(JSON.stringify([locale, source, text])).digest("hex");

const characterFields = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt", "publicMemory"];
/** Editorial replacements are tied to the exact original revision, never applied to changed cards. */
export function applyReviewedCharacterFields(row, review) {
  if (!review?.fields) return;
  if (review.sourceHash !== row.sourceHash) throw new Error(`Outdated editorial review for ${row.characterId}/${row.locale}`);
  const variables = text => (String(text ?? "").match(/\{\{[^{}]+\}\}/g) || []).sort();
  for (const [field, value] of Object.entries(review.fields)) {
    if (!characterFields.includes(field) || typeof value !== "string" || !value.trim()) throw new Error(`Invalid reviewed character field: ${field}`);
    if (JSON.stringify(variables(value)) !== JSON.stringify(variables(row[field]))) throw new Error(`Reviewed character field changed variables: ${field}`);
  }
  Object.assign(row, review.fields);
}

export function adaptPluralForms(object, intl) {
  const categories = new Intl.PluralRules(intl).resolvedOptions().pluralCategories;
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === "object") adaptPluralForms(value, intl);
    const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
    if (match && Object.hasOwn(object, `${match[1]}_other`)) {
      for (const category of categories) object[`${match[1]}_${category}`] ??= object[`${match[1]}_other`];
      if (!categories.includes(match[2])) delete object[key];
    }
  }
  return object;
}

/** Parameter values are JSON encoded as base64, so card text can never become SQL syntax. */
export function translationImportSql(records, fields, options = {}) {
  if (!records.length) throw new Error("No translations to import");
  if (records.some(row => !row.characterId || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(row.locale) || !/^[a-f0-9]{64}$/.test(row.sourceHash))) throw new Error("Invalid translation record");
  const payload = Buffer.from(JSON.stringify(records)).toString("base64");
  const safeFields = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt", "publicMemory"];
  if (JSON.stringify(fields) !== JSON.stringify(safeFields)) throw new Error("Unexpected source field projection");
  const originals = fields.map(field => `'${field}', c."${field}"`).join(", ");
  const quoted = fields.map(field => `"${field}"`);
  if(options.pipelineHash && !/^[a-f0-9]{64}$/.test(options.pipelineHash))throw new Error("Invalid translation policy hash");
  const extraColumns=options.pipelineHash?',"pipelineHash","qualityReviewedAt"':'';
  const extraValues=options.pipelineHash?`, '${options.pipelineHash}', CURRENT_TIMESTAMP`:'';
  // A legacy import must not inherit the quality stamp of the v2 row it replaces.
  const extraUpdate=options.pipelineHash?',"pipelineHash"=EXCLUDED."pipelineHash","qualityReviewedAt"=EXCLUDED."qualityReviewedAt"':',"pipelineHash"=NULL,"qualityReviewedAt"=NULL';
  return `BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='60s';\nWITH input AS (\n  SELECT * FROM jsonb_to_recordset(convert_from(decode('${payload}','base64'),'UTF8')::jsonb) AS r("characterId" text, locale text, "sourceHash" text, ${quoted.map(field => `${field} text`).join(", ")}, source jsonb)\n), eligible AS MATERIALIZED (\n  SELECT r.* FROM input r JOIN public."Character" c ON c.id=r."characterId"\n  WHERE c."isPublic"=true AND jsonb_build_object(${originals})=r.source\n  FOR UPDATE OF c\n), saved AS (\n  INSERT INTO public."CharacterTranslation" ("characterId",locale,"sourceHash",${quoted.join(",")},"updatedAt"${extraColumns})\n  SELECT "characterId",locale,"sourceHash",${quoted.join(",")},CURRENT_TIMESTAMP${extraValues} FROM eligible\n  ON CONFLICT ("characterId",locale) DO UPDATE SET "sourceHash"=EXCLUDED."sourceHash",${quoted.map(field=>`${field}=EXCLUDED.${field}`).join(",")},"updatedAt"=CURRENT_TIMESTAMP${extraUpdate}\n  RETURNING "characterId"\n) SELECT (SELECT COUNT(*) FROM input) AS prepared,(SELECT COUNT(*) FROM saved) AS saved,(SELECT COUNT(*) FROM input)-(SELECT COUNT(*) FROM saved) AS changed_or_unpublished;\nCOMMIT;\n`;
}
