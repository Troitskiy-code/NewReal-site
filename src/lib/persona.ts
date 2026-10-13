import { ClientInputError } from "./publicError";
export const PERSONA_NAME_MAX = 80;
export const PERSONA_DESCRIPTION_MAX = 500;

export type ChatPersona = {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  isGlobal: boolean;
  characterId: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export function parsePersonaPayload(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new ClientInputError("Имя обязательно");
  }
  if (name.length > PERSONA_NAME_MAX) {
    throw new ClientInputError(`Имя не длиннее ${PERSONA_NAME_MAX} символов`);
  }

  let description: string | null = null;
  if (typeof body.description === "string") {
    const trimmed = body.description.trim();
    if (trimmed.length > PERSONA_DESCRIPTION_MAX) {
      throw new ClientInputError(`Описание не длиннее ${PERSONA_DESCRIPTION_MAX} символов`);
    }
    description = trimmed || null;
  }

  const avatarUrl =
    typeof body.avatarUrl === "string" && body.avatarUrl.trim() ? body.avatarUrl.trim() : null;

  const isGlobal = body.isGlobal === true;
  const characterId =
    !isGlobal && typeof body.characterId === "string" && body.characterId.trim()
      ? body.characterId.trim()
      : null;

  return { name, description, avatarUrl, isGlobal, characterId };
}
