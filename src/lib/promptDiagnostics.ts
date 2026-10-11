import { createHash } from "node:crypto";
import { countTokens } from "./tokenCount";
import { infoLog } from "./logger";
import { chatModelGenerationOptions } from "./testingChatModels";
import { PROMPT_BUILDER_VERSION, type PromptAssembly } from "./chatSystemPrompt";

function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }
const SOURCE_NAMES = new Set(["card.name", "card.appearance", "card.personality", "card.universe", "card.group-scene", "card.npcs", "card.motivations", "card.speech-style", "card.relationships", "card.world", "card.initial-scenario", "card.narrative-preferences", "card.canonical-corrections", "card.voice-examples-not-events", "user.persona", "core", "events", "summary", "quotes",
  ...Array.from({ length: 8 }, (_, index) => ["identity", "personality", "appearance", "voice"].map(field => `card.cast.${index + 1}.${field}`)).flat()]);
export function promptAssemblyDiagnostics(assembly: PromptAssembly) {
  return { version: assembly.version, mode: assembly.mode, hash: digest(assembly.content), truncatedSources: assembly.truncatedSources ?? [],
    blocks: assembly.blocks.map(block => ({ source: block.source, chars: block.content.length, tokens: countTokens(block.content), hash: digest(block.content) })) };
}
export function logPromptDelivery(modelName: string, messages: { role: string; content: string }[], stream: boolean): void {
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  const version = system.startsWith(`Правила приложения (${PROMPT_BUILDER_VERSION})`) || system.startsWith(`Application rules (${PROMPT_BUILDER_VERSION})`) ? PROMPT_BUILDER_VERSION : "rp-v1";
  // Fixed structure, no full private card, history, secrets, error or upstream dump.
  infoLog("PromptDelivery", JSON.stringify({ version, modelName, stream,
    parameters: { ...chatModelGenerationOptions(modelName), ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) },
    sources: [...new Set([...system.matchAll(/\[\[(?:DATA|MEMORY):([a-z0-9.-]+)\]\]/g)].map(match => match[1]).filter(source => SOURCE_NAMES.has(source)))],
    messages: messages.map(message => ({ role: message.role, chars: message.content.length, tokens: countTokens(message.content), hash: digest(message.content) })),
  }));
}
