const RANDOM_EVENT_CHANCE = 0.3;

const RANDOM_EVENTS = [
  "Где-то вдалеке хлопнула дверь.",
  "Внезапно подул холодный ветер.",
  "Ты слышишь шаги за спиной.",
  "На мгновение свет померк.",
  "Раздался тихий шорох за стеной.",
  "С потолка осыпалась тонкая пыль.",
  "Где-то рядом звякнуло стекло.",
  "В воздухе потянуло дымом и пеплом.",
  "За окном прокричала ночная птица.",
  "По полу пробежала быстрая тень.",
  "Скрипнула половица, хотя никто не двигался.",
  "Капля воды упала в тишину с металлическим звуком.",
  "Вдалеке послышался приглушённый смех.",
  "Пламя свечи дрогнуло, будто кто-то прошёл мимо.",
  "На миг показалось, что кто-то произнёс твоё имя.",
];

export function pickRandomSceneEvent(): string | null {
  if (Math.random() >= RANDOM_EVENT_CHANCE) {
    return null;
  }

  return RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
}

export function appendRandomEventToPrompt(systemPrompt: string, event: string): string {
  return `${systemPrompt}\n\nСлучайное событие: впиши в сцену уместно, не ломая сюжет: ${event}`;
}
