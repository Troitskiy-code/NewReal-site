import { ClientInputError } from "./publicError";

export const ROLEPLAY_MODES = ["character", "world"] as const;
export type RoleplayMode = typeof ROLEPLAY_MODES[number];
export const ROLEPLAY_STYLES = ["dialogue", "narrative", "mixed"] as const;
export type RoleplayStyle = typeof ROLEPLAY_STYLES[number];
export const RP_FIELD_LIMITS = {
  motivations: 1000, speechStyle: 1000, relationships: 1500,
  world: 3000, narrativeRules: 1500, canonicalNotes: 1500,
} as const;
export type RoleplayConfig = Partial<Record<keyof typeof RP_FIELD_LIMITS, string>>;
export function roleplayMode(value: unknown): RoleplayMode { return value === "world" ? "world" : "character"; }
export function roleplayStyle(value: unknown): RoleplayStyle {
  return value === "dialogue" || value === "narrative" ? value : "mixed";
}
export function parseRoleplayFields(body: Record<string, unknown>) {
  if (body.roleplayMode !== undefined && !ROLEPLAY_MODES.includes(body.roleplayMode as RoleplayMode)) throw new ClientInputError("Неизвестный тип ролевого чата");
  if (body.roleplayStyle !== undefined && !ROLEPLAY_STYLES.includes(body.roleplayStyle as RoleplayStyle)) throw new ClientInputError("Неизвестный стиль ответа");
  const config: RoleplayConfig = {};
  if (body.rpConfig !== undefined) {
    if (!body.rpConfig || typeof body.rpConfig !== "object" || Array.isArray(body.rpConfig)) throw new ClientInputError("Некорректные настройки истории");
    const raw = body.rpConfig as Record<string, unknown>;
    for (const field of Object.keys(RP_FIELD_LIMITS) as (keyof RoleplayConfig)[]) {
      if (raw[field] === undefined || raw[field] === null) continue;
      if (typeof raw[field] !== "string" || raw[field].length > RP_FIELD_LIMITS[field]) throw new ClientInputError(`Поле ${field}: максимум ${RP_FIELD_LIMITS[field]} символов`);
      config[field] = raw[field].trim();
    }
  }
  return { roleplayMode: roleplayMode(body.roleplayMode), roleplayStyle: roleplayStyle(body.roleplayStyle), rpConfig: config };
}
export function readRoleplayConfig(value: unknown): RoleplayConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config: RoleplayConfig = {};
  for (const field of Object.keys(RP_FIELD_LIMITS) as (keyof RoleplayConfig)[]) {
    const text = (value as Record<string, unknown>)[field];
    if (typeof text === "string") config[field] = text.slice(0, RP_FIELD_LIMITS[field]);
  }
  return config;
}
