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

const RANDOM_EVENTS_EN = [
  "A door slams somewhere in the distance.",
  "A cold wind suddenly picks up.",
  "You hear footsteps behind you.",
  "The light flickers for a moment.",
  "A quiet rustle comes from behind the wall.",
  "A thin film of dust sifts down from the ceiling.",
  "Glass clinks nearby.",
  "The air carries a hint of smoke and ash.",
  "A night bird cries outside.",
  "A quick shadow darts across the floor.",
  "A floorboard creaks, though nobody moved.",
  "A drop of water falls into the silence with a metallic sound.",
  "Muffled laughter carries from far away.",
  "The candle flame wavers as if someone passed by.",
  "For a second it seems someone whispered your name.",
];

export function pickRandomSceneEvent(locale?: string): string | null {
  if (Math.random() >= RANDOM_EVENT_CHANCE) {
    return null;
  }

  const events = locale === "en" ? RANDOM_EVENTS_EN : RANDOM_EVENTS;
  return events[Math.floor(Math.random() * events.length)];
}

export function appendRandomEventToPrompt(
  systemPrompt: string,
  event: string,
  locale?: string
): string {
  return locale === "en"
    ? `${systemPrompt}\n\nRandom event: weave this into the scene without breaking the plot: ${event}`
    : `${systemPrompt}\n\nСлучайное событие: впиши в сцену уместно, не ломая сюжет: ${event}`;
}
