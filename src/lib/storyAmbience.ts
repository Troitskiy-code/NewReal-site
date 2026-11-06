import { splitStoryChoices } from "@/lib/storyChoices";

// Russian destination/current forms, Russian exit forms and English names.
const INDOOR_PLACES = {
  kitchen: [/кухн[яею]/, /кухни/, /kitchen/],
  "living-room": [/гостин(?:ая|ой|ую)|общ(?:ая|ей|ую) комнат[аеу]/, /гостиной|общей комнаты/, /living room|sitting room|lounge/],
  bedroom: [/спальн[яею]/, /спальни/, /bedroom/],
  bathroom: [/ванн(?:ая(?: комната)?|ой(?: комнате)?|ую(?: комнату)?)|душев(?:ая|ой|ую)|санузле?/, /ванной(?: комнаты)?|душевой|санузла/, /bathroom|shower room|washroom/],
  store: [/магазине?|супермаркете?|торгов(?:ом|ый) зал[е]?|торгов(?:ом|ый) центр[е]?/, /магазина|супермаркета|торгового (?:зала|центра)/, /shop|store|supermarket|grocery store|mall/],
  cafe: [/кафе|кофейн[яею]|ресторане?|столов(?:ая|ой|ую)/, /кафе|кофейни|ресторана|столовой/, /caf[eé]|coffee shop|restaurant|diner|cafeteria/],
  club: [/ночн(?:ом|ой) клубе?|дискотек[аеу]|танцполе?/, /ночного клуба|дискотеки|танцпола/, /nightclub|dance club|dance floor|disco/],
  office: [/офисе?|рабоч(?:ем|ий) кабинете?/, /офиса|рабочего кабинета/, /office|workspace|coworking space/],
  library: [/библиотек[аеу]|читальн(?:ом|ый) зале?/, /библиотеки|читального зала/, /library|reading room/],
} as const;

type IndoorPlace = keyof typeof INDOOR_PLACES;
export type StoryAmbience = "rain" | "forest" | "city" | "shore" | "tavern" | IndoorPlace;
type Place = Exclude<StoryAmbience, "rain">;
type Cue = Place | "rain" | "exposedRain" | "dry" | "inside" | "outside";

const RU_ROOM_ENTRY = /(?:(?<!\p{L})(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|входи(?:т|м|те|шь)|заходи(?:т|м|те|шь)|переш(?:[её]л|ла|ли)|прош(?:[её]л|ла|ли)|оказал(?:ся|ась|ись)|проснул(?:ся|ась|ись)|остал(?:ся|ась|ись)|сел(?:а|и)?|сид(?:ел[аи]?|ели|ит|ят)|танцева(?:л[аи]?|ли)|работа(?:л[аи]?|ли)|(?:вы|мы|они)(?:\s+уже)?(?:\s+(?:сидите|сидим|сидят|стоите|стоим|стоят))?)\s+|^\s*[*_]*)(?:в|во|на)\s+/u.source;
const EN_ROOM_ENTRY = /(?:\b(?:into|onto|inside|enter(?:ed|s)?|(?:you are|you're|we are|we're|they are|sit|sat|sitting|stand|stood|standing|danc(?:e|ed|ing)|work(?:ed|ing)?|wake up|wait)\s+in)\s+|^\s*[*_]*in\s+)(?:the |an? |your |his |her )?/.source;
const RU_ROOM_EXIT = /(?<!\p{L})(?:выш(?:[её]л|ла|ли)|выходи(?:т|м|те|шь)|выйдя|выходя|выбежа(?:л|ла|ли))\s+из\s+/u.source;
const EN_ROOM_EXIT = /\b(?:(?:step(?:ped)?|walk(?:ed)?|come|came|go|went|run|ran|head(?:ed)?)\s+out of|leave|left)\s+(?:the |an? |your |his |her )?/.source;
const RU_ROOM_ADJECTIVES = /(?:\p{L}+(?:ый|ий|ая|яя|ую|ом|ой|ем|ей|ое)\s+){0,2}/u.source;
const EN_ROOM_ADJECTIVES = /(?:(?:quiet|small|busy|crowded|warm|empty|dark|bright|local|open-plan)\s+){0,2}/.source;
const WORD_END = /(?!\p{L})/u.source;
const ROOM_HEADING = /^\s*[*_]*(?:локация|сцена|место действия|location|scene)[*_]*\s*:\s*[*_]*\s*/iu;
const HOME_ROOMS = new Set<IndoorPlace>(["kitchen", "living-room", "bedroom", "bathroom"]);

const indoorCues: ReadonlyArray<[Cue, RegExp]> = (Object.keys(INDOOR_PLACES) as IndoorPlace[]).flatMap(place => {
  const [ru, ruExit, en] = INDOOR_PLACES[place];
  const exitCue = HOME_ROOMS.has(place) ? "inside" : "outside";
  const ruDestination = RU_ROOM_ADJECTIVES + "(?:" + ru.source + ")" + WORD_END;
  const enDestination = EN_ROOM_ADJECTIVES + "(?:" + en.source + ")" + WORD_END;
  const ruExitPlace = RU_ROOM_EXIT + RU_ROOM_ADJECTIVES + "(?:" + ruExit.source + ")" + WORD_END;
  return [
    [place, new RegExp("(?:" + RU_ROOM_ENTRY + "|" + ROOM_HEADING.source + ")" + ruDestination, "giu")],
    [place, new RegExp("(?:" + EN_ROOM_ENTRY + "|" + ROOM_HEADING.source + ")" + enDestination, "giu")],
    [exitCue, new RegExp(ruExitPlace, "giu")],
    [exitCue, new RegExp(EN_ROOM_EXIT + enDestination, "giu")],
    ["outside", new RegExp(ruExitPlace + /\s+(?:во двор|наружу|на улицу)(?!\p{L})/u.source, "giu")],
  ];
});

// Match events in the current scene. Bare words such as "дождь" and "лес"
// also occur in dialogue, plans and descriptions of other places.
const CUES: ReadonlyArray<[Cue, RegExp]> = [
  ["tavern", /(?<!\p{L})(?:в\s+(?:таверне|трактире|постоялом дворе)\s+(?:(?:за)?(?:грем|звен|шум)\p{L}*|у камина|за столами)|(?:проснул(?:ся|ась|ись)|очнул(?:ся|ась|ись))\s+в\s+(?:таверне|трактире)|(?:внутри|за столом)\s+(?:таверны|трактира))/giu],
  ["tavern", /(?<!\p{L})(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли))\s+в\s+(?:\p{L}+(?:ую|ый)\s+)(?:таверну|трактир)(?!\p{L})/giu],
  ["tavern", /\b(?:you're in|you are in|into|inside)\s+(?:the |an? )?(?:(?:crowded|quiet|tiny|busy|small|dim|warm)\s+)*(?:tavern|inn|pub)(?!\p{L})/giu],
  ["tavern", /(?<!\p{L})(?:(?:на стол|за столом|в зале|внутри|шум|гул)\s+(?:таверны|трактира|постоялого двора)|(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|входи(?:т|м|те|шь)|заходи(?:т|м|те|шь)|оказал(?:ся|ась|ись)|сидим|сидите|сидят|сели)\s+в\s+(?:таверн[уе]|трактир[е]?|постоял(?:ый двор|ом дворе))|(?:мы|вы|они)\s+(?:уже\s+)?в\s+(?:таверне|трактире|постоялом дворе))(?!\p{L})/giu],
  ["tavern", /\b(?:into|inside|(?:sit|are|wait|stand)\s+in)\s+(?:the |an? )?(?:tavern|inn|pub)(?!\p{L})/giu],
  ["outside", /(?<!\p{L})(?:выш[её]л|вышла|вышли|выходи(?:т|м|те|шь)|выйдя|выходя)\s+(?:наружу|на свежий воздух|на дорогу|во двор|на мокрую улицу|из\s+(?:таверны|трактира|постоялого двора|дома|здания|замка|борделя))(?!\p{L})/giu],
  ["outside", /\b(?:stepped|walked|went|came)\s+(?:back\s+)?(?:outside|out of\s+(?:the |a )?(?:tavern|inn|building|brothel)|onto\s+(?:the |a )?(?:road|path))\b/giu],
  ["outside", /(?<!\p{L})(?:(?:шагнул[аи]?|шагнули|выбежа(?:л[аи]?|ли)|выскочи(?:л[аи]?|ли)|выбрал(?:ся|ась|ись))\s+(?:на улицу|во двор|наружу|из\s+(?:таверны|трактира|дома|укрытия))|(?:покинул[аи]?|покинули)\s+(?:таверну|трактир|помещение|укрытие)|за порогом\s+(?:вы|он[аи]?)\s+(?:\p{L}+\s+){0,2}во дворе|(?:мокрая\s+)?мостовая\s+\p{L}+\s+под ногами)/giu],
  ["outside", /\b(?:(?:step(?:ped)?|walk(?:ed)?|run|ran)\s+out\s+(?:of\s+(?:the |an? )?(?:tavern|inn|building|brothel)|into\s+(?:the |an? )?(?:street|rain))|(?:leave|left)\s+(?:the |an? )?(?:tavern|inn|building|shelter))\b/giu],
  ["inside", /(?<!\p{L})(?:(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|входи(?:т|м|те|шь)|заходи(?:т|м|те|шь)|забежа(?:л[аи]?|ли)|укрыл[аи]?с[ья]|укрылись|оказал(?:ся|ась|ись)|переш(?:[её]л|ла|ли))\s+(?:внутрь|в\s+(?:дом|комнат|здани|подъезд|помещени|коридор|зал|замок)\p{L}*)|(?:мы|вы|они)\s+(?:уже\s+)?в\s+(?:помещении|комнате|доме|замке|(?:большом\s+)?зале))/giu],
  ["inside", /\b(?:stepped|walked|went|go|goes|hurried|ran|came)\s+(?:back\s+)?(?:inside|indoors|into\s+(?:the |a )?(?:house|room|building|hall|castle))\b|\b(?:you are|they are|we are|you're|we're)\s+(?:now\s+)?(?:inside|indoors)\b/giu],
  ["inside", /(?<!\p{L})(?:(?:укрыл(?:ись|ся|ась)|скрыл(?:ись|ся|ась)|спрятал(?:ись|ся|ась))\s+под\s+(?:навесом|крышей)|сел(?:и|а)?\s+в\s+(?:машину|автомобиль|карету)|(?:вы|мы|они)\s+(?:уже\s+)?в\s+(?:каменном\s+)?подвале)(?!\p{L})/giu],
  ["inside", /\b(?:take|took|find|found)\s+shelter\s+(?:under|inside)\b|\b(?:get|got|climb(?:ed)?)\s+into\s+(?:the |an? )?(?:car|vehicle|carriage)\b/giu],
  ["forest", /(?<!\p{L})(?:(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|углубил(?:ись|ся|ась)|оказа(?:лись|лся|лась)|находитесь)\s+(?:в|во)\s+(?:густой\s+|т[её]мный\s+)?(?:лес(?:а|е|у|ом)?|лесопарк(?:е)?|рощ[уе]|чащ[еу])(?!\p{L})|(?:мы|вы|они)\s+(?:(?:стоите|ид[её]те|стоим|ид[её]м|стоят|идут)\s+)?в\s+лесу|(?:по|вдоль)\s+лесной\s+троп\p{L}*|(?:вокруг|над вами)\s+(?:шелест\p{L}*\s+)?(?:деревья|кроны))/giu],
  ["forest", /\b(?:into|through|within|amid|(?:stand|wait|sit|are|wake|find yourself)\s+in)\s+(?:the |a )?(?:forest|woods|woodland)\b|\b(?:the trees|forest canopy)\s+(?:surround|sway|rustle)\b/giu],
  ["forest", /(?<!\p{L})(?:посреди\s+(?:\p{L}+\s+)?леса|лес\s+окружа(?:ет|л)\s+(?:вас|героя)|(?:свернул[аи]?|свернули)\s+в\s+(?:\p{L}+\s+)?лес|тропа\s+(?:уводит|вед[её]т)\s+вас\s+в чащу|(?:на|по)\s+лесн(?:ую|ой)\s+троп\p{L}*)(?!\p{L})/giu],
  ["forest", /\b(?:wake up|find yourself|stand|walk)\s+in\s+(?:the |an? )?(?:(?:dark|thick|dense|pine|quiet)\s+)*(?:forest|woods|woodland)\b/giu],
  ["city", /(?<!\p{L})(?:(?:выш(?:[её]л|ла|ли)|выходи(?:т|м|те|шь)|оказал(?:ся|ась|ись))\s+на\s+(?:оживл[её]нную\s+|городскую\s+)?улицу|(?:на|по)\s+(?:мокрой\s+|городской\s+|оживл[её]нной\s+)?улице\s+(?:шум\p{L}*|гуде\p{L}*|едут|слыш\p{L}*)|(?:гул|шум)\s+(?:машин|города|транспорта))/giu],
  ["city", /\b(?:onto|along|down)\s+(?:(?:the|a)\s+)?(?:(?:busy|city|wet)\s+)?(?:street|sidewalk)\b|\b(?:traffic|the city)\s+(?:hums|rumbles|roars|bustles)\b/giu],
  ["city", /(?<!\p{L})(?:(?:проносятся|проезжают|едут)\s+(?:мимо\s+)?машины|(?:вы|мы)\s+(?:стоите|стоим|ид[её]те|ид[её]м)\s+на\s+(?:оживл[её]нной\s+)?городской улице)(?!\p{L})/giu],
  ["city", /\b(?:cars|buses|trucks)\s+(?:rush|drive|roll|speed)\s+past\b/giu],
  ["shore", /(?<!\p{L})(?:(?:выш(?:[её]л|ла|ли)|подош(?:[её]л|ла|ли)|спустил(?:ся|ась|ись)|оказал(?:ся|ась|ись))\s+(?:к|на)\s+(?:песчан\p{L}*\s+)?(?:берег\p{L}*|пляж\p{L}*|побереж\p{L}*)|(?:мы|вы|они)\s+(?:(?:стоите|стоим|стоят|сидите|сидим|сидят)\s+)?на\s+(?:берегу|пляже|побережье)|(?:волны|прибой)\s+(?:набега\p{L}*|шум\p{L}*|бь\p{L}*|омыва\p{L}*|накатыва\p{L}*))/giu],
  ["shore", /\b(?:onto|along|down to|(?:stand|wait|sit|are|wake)\s+on)\s+(?:(?:the|a)\s+)?(?:beach|shore|coastline)\b|\b(?:waves|surf)\s+(?:lap|laps|crash|crashes|roll|break)\b/giu],
  ["shore", /(?<!\p{L})(?:у кромки моря|у ваших ног\s+\p{L}+\s+прибой|спустил(?:ись|ся|ась)\s+к\s+(?:самому\s+)?берегу)(?!\p{L})/giu],
  ["shore", /\b(?:emerge(?:d)? onto|waves\s+wash over)\s+(?:(?:the|an?|your)\s+)?(?:(?:empty|deserted|sandy)\s+)?(?:beach|shore|feet)\b|\bsurf\s+breaks\b/giu],
  // Rain soaking a person is evidence of exposure, unlike rain on a roof or beyond a window.
  ["exposedRain", /(?<!\p{L})(?:выш[её]л|вышла|вышли|выходи(?:т|м|те|шь)|выйдя|выходя)\s+на дождливую улицу(?!\p{L})/giu],
  ["exposedRain", /(?<!\p{L})(?:дождь|ливень)\s+(?:(?:мгновенно|сразу|быстро|насквозь)\s+)?(?:пропитал|промочил|намочил|пропитыва(?:л|ет)|промачива(?:л|ет))\s+(?:(?:вашу|твою|его|её|их)\s+)?(?:одежду|плащ|куртку|пальто|волосы)(?!\p{L})/giu],
  ["exposedRain", /\b(?:rain|downpour)\s+(?:(?:instantly|quickly|already)\s+)?(?:soak(?:ed|s)|drench(?:ed|es))\s+(?:(?:your|his|her|their|the)\s+)?(?:clothes|clothing|cloak|coat|jacket|hair)\b/giu],
  ["exposedRain", /(?<!\p{L})(?:за порогом\s+(?:вас|его|её|их)\s+(?:тут же\s+)?накрыл\s+ливень|(?:шагнул[аи]?|шагнули|выш[её]л|вышла|вышли)\s+на улицу\s+под\s+(?:проливной\s+)?дождь)(?!\p{L})/giu],
  ["exposedRain", /\b(?:(?:step(?:ped)?|walk(?:ed)?)\s+into\s+(?:the\s+)?(?:pouring\s+)?rain|(?:rain|downpour)\s+drenches\s+you)\b/giu],
  ["rain", /(?<!\p{L})(?:(?:дождь|ливень)\s+(?:(?:вс[её] ещ[её]|по-прежнему|уже|снова)\s+)?(?:ид[её]т|ш[её]л|начал(?:ся| идти)|ль[её]т|лил|забарабанил|барабанит|моросит|стучит|усилил(?:ся|ивается)|продолжает(?:ся)?)|(?<!не )(?:пош[её]л|ш[её]л|начался|ль[её]т|лил|ид[её]т|проливной)\s+(?:(?:сильный|мелкий|т[её]плый|холодный)\s+)?(?:дождь|ливень)|на улице\s+(?:вс[её] ещ[её]\s+)?(?:дождь|ливень)(?!\p{L})|капли\s+дождя\s+(?:стуч\p{L}*|барабан\p{L}*|пада\p{L}*)|под\s+(?:проливным\s+)?дожд[её]м)/giu],
  ["rain", /\b(?:it's|it is|it was)\s+(?:still\s+)?raining\b|\b(?:rain|the downpour)\s+(?:(?:still|now)\s+)?(?:falls|fell|pours|poured|beats|patters|drums|starts|started|begins|began|continues|continued)\b|\b(?:starts|started|begins|began)\s+to\s+rain\b/giu],
  ["rain", /(?<!\p{L})(?:хлынул\s+(?:ливень|дождь)|хлынуло(?=[^.!?…;]{0,140}(?:зонт|капл\p{L}*\s+дождя))|задожди(?:ло|л)|(?:снаружи|на улице)\s+моросит|дождь\s+(?:снова\s+)?(?:зарядил|хлестал|хлещет)|упали\s+(?:первые\s+)?капли дождя)(?!\p{L})/giu],
  ["rain", /\b(?:it\s+(?:began|started)\s+raining|rain\s+(?:(?:is|was)\s+falling|lashes))\b/giu],
  ["dry", /(?<!\p{L})(?:(?:дождь|ливень)\s+(?:стих\p{L}*|прекра(?:тил|ща)\p{L}*|законч\p{L}*|переста\p{L}*|утих\p{L}*|не ид[её]т)|не\s+ид[её]т\s+дождь|(?:перестал(?:о)?\s+(?:лить|моросить)|дождя\s+(?:больше\s+)?нет))/giu],
  ["dry", /\b(?:rain|downpour)\s+(?:(?:has|had|finally)\s+)*(?:stops|stopped|ends|ended|eases|eased|lets up|let up|clears|cleared)\b|\b(?:stopped raining|no longer raining)\b/giu],
  ["dry", /(?<!\p{L})(?:(?:ливень|дождь)\s+сош[её]л на нет|перестало капать с неба|небо прояснилось)(?!\p{L})/giu],
  ["dry", /\b(?:not raining anymore|(?:rain|downpour)\s+(?:has\s+passed|dies\s+down|died\s+down))\b/giu],
  ["club", /^\s*[*_]*в клубе\s+[^.!?…;]{0,40}(?:бас[ыа]?(?!\p{L})|диджей|танцпол)/giu],
  ["club", /^\s*[*_]*in the club\b[^.!?…;]{0,40}\b(?:bass|dj|dance floor)\b/giu],
  // A specific room takes precedence over a generic shelter at the same position.
  ...indoorCues,
];

const NON_CURRENT = /(?:^|[^\p{L}])(?:если|мог(?:ли|ла)? бы|может быть|наверное|завтра|вчера|накануне|раньше|когда-то|(?:лет|дней|часов)\s+назад|во сне|ещ[её]\s+(?:до этого|на дороге)|вспомнил\p{L}*|вспомина\p{L}*|представил\p{L}*|приснил\p{L}*|предложил\p{L}*|будет|обещали|прогноз|(?:сказал|ответил|уточнил|шепнул|прошептал)\p{L}*,?\s+что|на\s+(?:картине|фотографии|рисунке|карте))(?=$|[^\p{L}])|\b(?:if|would|might|maybe|tomorrow|yesterday|earlier|used to|remember\w*|imagin\w*|dream\w*|forecast|suggested|proposed|said|photograph|illustration|painting)\b/iu;
const NEGATED = /(?:^|[^\p{L}])(?:не(?!\s+только)|почти|not(?!\s+only)|never|almost|(?:did|has|had|was|could)n['’]t)(?:\s+\p{L}+){0,2}\s*$/iu;
const THROUGH_WINDOW = /(?:^|[^\p{L}])(?:за\s+(?:окном|стеклом)|через\s+(?:окно|стекло))(?=$|[^\p{L}])|\b(?:behind|through|outside)\s+(?:the|a)\s+window\b/iu;
const PLANNED_VISIT = /(?<!\p{L})(?:собира\p{L}*|планиру\p{L}*|решил[аи]?)\s+(?:пойти|зайти|выйти|посетить)(?!\p{L})|\b(?:plan(?:s|ned|ning)?|want(?:s|ed)?|intend(?:s|ed)?)\s+to\s+(?:go|walk|enter|head|leave|visit)\b/iu;
const CLAUSE_BREAK = /(?<=[.!?…;])|\r?\n|,\s*(?=(?:но|хотя|а\s+(?:сейчас|теперь)|but|although)(?!\p{L}))/iu;
const RAIN_REFERENCE = /(?<!\p{L})(?:дождь|ливень)(?!\p{L})/iu;
const RAIN_CONTINUATION = /^\s*(?:а\s+)?(?:сейчас|теперь)\s+(?:он\s+)?(?:снова|опять)\s+ль[её]т(?!\p{L})/iu;
const DIALOGUE_LINE = /^\s*(?:[—–-]\s|>\s|(?:\*{1,2})?[\p{L}\p{N}][\p{L}\p{N} .'-]{0,30}(?:\*{1,2})?:)/u;

function sceneText(content: string) {
  const choices = splitStoryChoices(content);
  return (choices ? `${choices.before}\n${choices.after}` : content)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/`[^`\n]*`|«[^»]*»|“[^”]*”|"[^"\n]*"/g, "")
    .split("\n")
    .map(line => DIALOGUE_LINE.test(line) && !ROOM_HEADING.test(line)
      ? Array.from(line.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g), match => match[1] ?? match[2]).join(" ")
      : line)
    .join("\n");
}

export function storyAmbience(messages: ReadonlyArray<{ role: string; content: string }>): StoryAmbience | null {
  let place: Place | null = null;
  let rain = false;
  let indoors = false;
  for (const { role, content } of messages) {
    if (role !== "assistant") continue;
    let previousClauseMentionsRain = false;
    for (const clause of sceneText(content).split(CLAUSE_BREAK)) {
      const rainContinues = previousClauseMentionsRain && RAIN_CONTINUATION.test(clause);
      previousClauseMentionsRain = RAIN_REFERENCE.test(clause);
      if (clause.trimEnd().endsWith("?") || NON_CURRENT.test(clause) || PLANNED_VISIT.test(clause)) continue;
      if (rainContinues) rain = true;
      const throughWindow = THROUGH_WINDOW.test(clause);
      const events = CUES.flatMap(([cue, pattern]) => Array.from(clause.matchAll(pattern), match => ({
        cue,
        index: match.index,
      }))).sort((a, b) => a.index - b.index);
      for (const { cue, index } of events) {
        if (NEGATED.test(clause.slice(0, index))) continue;
        if (throughWindow && cue !== "rain" && cue !== "dry") continue;
        if (cue === "rain") rain = true;
        else if (cue === "exposedRain") {
          rain = true;
          if (indoors) place = null;
          indoors = false;
        } else if (cue === "dry") rain = false;
        else {
          indoors = cue === "inside" || cue === "tavern" || Object.hasOwn(INDOOR_PLACES, cue);
          place = cue === "inside" || cue === "outside" ? null : cue;
        }
      }
    }
  }
  return rain && !indoors ? "rain" : place;
}
