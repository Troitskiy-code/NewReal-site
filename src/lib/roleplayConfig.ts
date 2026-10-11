import { ClientInputError } from "./publicError";

export const ROLEPLAY_MODES = ["character", "world", "group"] as const;
export type RoleplayMode = typeof ROLEPLAY_MODES[number];
export const ROLEPLAY_STYLES = ["dialogue", "narrative", "mixed"] as const;
export type RoleplayStyle = typeof ROLEPLAY_STYLES[number];
export const RP_FIELD_LIMITS = {
  motivations: 1000, speechStyle: 1000, relationships: 1500,
  world: 3000, narrativeRules: 1500, canonicalNotes: 1500, npcs: 2000,
} as const;
export const MAX_GROUP_PARTICIPANTS = 8;
export const GROUP_FIELD_LIMITS = { name: 80, description: 1000, appearance: 400, speechStyle: 300 } as const;
export type GroupParticipant = { id: string } & Record<keyof typeof GROUP_FIELD_LIMITS, string>;
export type RoleplayTextConfig = Partial<Record<keyof typeof RP_FIELD_LIMITS, string>>;
export type RoleplayConfig = RoleplayTextConfig & { participants?: GroupParticipant[] };
export const ROLEPLAY_MODE_LABELS: Record<RoleplayMode, string> = { character: "Один персонаж", world: "Вселенная", group: "Несколько персонажей" };
export function roleplayMode(value: unknown): RoleplayMode { return value === "world" || value === "group" ? value : "character"; }
function parseParticipants(value: unknown): GroupParticipant[] {
  if (!Array.isArray(value) || value.length > MAX_GROUP_PARTICIPANTS) throw new ClientInputError(`В группе может быть до ${MAX_GROUP_PARTICIPANTS} персонажей`);
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id) || ids.has(raw.id)) throw new ClientInputError("Некорректный или повторяющийся ID участника");
    ids.add(raw.id);
    const member = { id: raw.id } as GroupParticipant;
    for (const field of Object.keys(GROUP_FIELD_LIMITS) as (keyof typeof GROUP_FIELD_LIMITS)[]) {
      const text = raw[field] ?? "";
      if (typeof text !== "string" || text.length > GROUP_FIELD_LIMITS[field]) throw new ClientInputError(`Участник: поле ${field}, максимум ${GROUP_FIELD_LIMITS[field]} символов`);
      member[field] = text.trim();
    }
    const nameKey = member.name.normalize("NFKC").toLocaleLowerCase();
    if (nameKey && names.has(nameKey)) throw new ClientInputError("Имена участников должны различаться");
    if (nameKey) names.add(nameKey);
    return member;
  });
}
export function validateGroupConfig(mode: unknown, value: unknown): void {
  if (mode !== "group") return;
  const participants = readRoleplayConfig(value).participants ?? [];
  if (!participants.length || participants.some(member => !member.name || !member.description)) throw new ClientInputError("Добавьте хотя бы одного участника и заполните его имя и характер");
}
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
    for (const field of Object.keys(RP_FIELD_LIMITS) as (keyof RoleplayTextConfig)[]) {
      if (raw[field] === undefined || raw[field] === null) continue;
      if (typeof raw[field] !== "string" || raw[field].length > RP_FIELD_LIMITS[field]) throw new ClientInputError(`Поле ${field}: максимум ${RP_FIELD_LIMITS[field]} символов`);
      config[field] = raw[field].trim();
    }
    if (raw.participants !== undefined) config.participants = parseParticipants(raw.participants);
  }
  return { roleplayMode: roleplayMode(body.roleplayMode), roleplayStyle: roleplayStyle(body.roleplayStyle), rpConfig: config };
}
export function readRoleplayConfig(value: unknown): RoleplayConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config: RoleplayConfig = {};
  for (const field of Object.keys(RP_FIELD_LIMITS) as (keyof RoleplayTextConfig)[]) {
    const text = (value as Record<string, unknown>)[field];
    if (typeof text === "string") config[field] = text.slice(0, RP_FIELD_LIMITS[field]);
  }
  const participants = (value as Record<string, unknown>).participants;
  if (participants !== undefined) {
    try { config.participants = parseParticipants(participants); } catch { config.participants = []; }
  }
  return config;
}
