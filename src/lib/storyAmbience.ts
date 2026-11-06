import { splitStoryChoices } from "@/lib/storyChoices";

export type StoryAmbience = "rain" | "forest" | "city" | "shore" | "tavern";
type Place = Exclude<StoryAmbience, "rain">;
type Cue = Place | "rain" | "dry" | "inside" | "outside";

// Match events in the current scene. Bare words such as "дождь" and "лес"
// also occur in dialogue, plans and descriptions of other places.
const CUES: ReadonlyArray<[Cue, RegExp]> = [
  ["tavern", /(?<!\p{L})(?:(?:на стол|за столом|в зале|внутри|шум|гул)\s+(?:таверны|трактира|постоялого двора)|(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|входи(?:т|м|те|шь)|заходи(?:т|м|те|шь)|оказал(?:ся|ась|ись)|сидим|сидите|сидят|сели)\s+в\s+(?:таверн[уе]|трактир[е]?|постоял(?:ый двор|ом дворе)|кафе)|(?:мы|вы|они)\s+(?:уже\s+)?в\s+(?:таверне|трактире|кафе|постоялом дворе))(?!\p{L})/giu],
  ["tavern", /\b(?:into|inside|(?:sit|are|wait|stand)\s+in)\s+(?:the |an? )?(?:tavern|inn|pub|caf[eé]|restaurant)(?!\p{L})/giu],
  ["outside", /(?<!\p{L})(?:выш[её]л|вышла|вышли|выходи(?:т|м|те|шь))\s+(?:наружу|на свежий воздух|на дорогу|во двор|из\s+(?:таверны|трактира|постоялого двора|дома|здания|замка))|\b(?:stepped|walked|went|came)\s+(?:back\s+)?(?:outside|out of\s+(?:the |a )?(?:tavern|inn|building)|onto\s+(?:the |a )?(?:road|path))\b/giu],
  ["inside", /(?<!\p{L})(?:(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|входи(?:т|м|те|шь)|заходи(?:т|м|те|шь)|забежа(?:л[аи]?|ли)|укрыл[аи]?с[ья]|укрылись|оказал(?:ся|ась|ись)|переш(?:[её]л|ла|ли))\s+(?:внутрь|в\s+(?:дом|комнат|здани|подъезд|помещени|коридор|зал|замок)\p{L}*)|(?:мы|вы|они)\s+(?:уже\s+)?в\s+(?:помещении|комнате|доме|замке|(?:большом\s+)?зале))/giu],
  ["inside", /\b(?:stepped|walked|went|go|goes|hurried|ran|came)\s+(?:back\s+)?(?:inside|indoors|into\s+(?:the |a )?(?:house|room|building|hall|castle))\b|\b(?:you are|they are|we are|you're|we're)\s+(?:now\s+)?(?:inside|indoors)\b/giu],
  ["forest", /(?<!\p{L})(?:(?:вош(?:[её]л|ла|ли)|заш(?:[её]л|ла|ли)|углубил(?:ись|ся|ась)|оказа(?:лись|лся|лась)|находитесь)\s+(?:в|во)\s+(?:густой\s+|т[её]мный\s+)?(?:лес(?:а|е|у|ом)?|лесопарк(?:е)?|рощ[уе]|чащ[еу])(?!\p{L})|(?:мы|вы|они)\s+(?:(?:стоите|ид[её]те|стоим|ид[её]м|стоят|идут)\s+)?в\s+лесу|(?:по|вдоль)\s+лесной\s+троп\p{L}*|(?:вокруг|над вами)\s+(?:шелест\p{L}*\s+)?(?:деревья|кроны))/giu],
  ["forest", /\b(?:into|through|within|amid|(?:stand|wait|sit|are|wake|find yourself)\s+in)\s+(?:the |a )?(?:forest|woods|woodland)\b|\b(?:the trees|forest canopy)\s+(?:surround|sway|rustle)\b/giu],
  ["city", /(?<!\p{L})(?:(?:выш(?:[её]л|ла|ли)|выходи(?:т|м|те|шь)|оказал(?:ся|ась|ись))\s+на\s+(?:оживл[её]нную\s+|городскую\s+)?улицу|(?:на|по)\s+(?:мокрой\s+|городской\s+|оживл[её]нной\s+)?улице\s+(?:шум\p{L}*|гуде\p{L}*|едут|слыш\p{L}*)|(?:гул|шум)\s+(?:машин|города|транспорта))/giu],
  ["city", /\b(?:onto|along|down)\s+(?:(?:the|a)\s+)?(?:(?:busy|city|wet)\s+)?(?:street|sidewalk)\b|\b(?:traffic|the city)\s+(?:hums|rumbles|roars|bustles)\b/giu],
  ["shore", /(?<!\p{L})(?:(?:выш(?:[её]л|ла|ли)|подош(?:[её]л|ла|ли)|спустил(?:ся|ась|ись)|оказал(?:ся|ась|ись))\s+(?:к|на)\s+(?:песчан\p{L}*\s+)?(?:берег\p{L}*|пляж\p{L}*|побереж\p{L}*)|(?:мы|вы|они)\s+(?:(?:стоите|стоим|стоят|сидите|сидим|сидят)\s+)?на\s+(?:берегу|пляже|побережье)|(?:волны|прибой)\s+(?:набега\p{L}*|шум\p{L}*|бь\p{L}*|омыва\p{L}*|накатыва\p{L}*))/giu],
  ["shore", /\b(?:onto|along|down to|(?:stand|wait|sit|are|wake)\s+on)\s+(?:(?:the|a)\s+)?(?:beach|shore|coastline)\b|\b(?:waves|surf)\s+(?:lap|laps|crash|crashes|roll|break)\b/giu],
  ["rain", /(?<!\p{L})(?:(?:дождь|ливень)\s+(?:(?:вс[её] ещ[её]|по-прежнему|уже|снова)\s+)?(?:ид[её]т|ш[её]л|начал(?:ся| идти)|ль[её]т|лил|забарабанил|барабанит|моросит|стучит|усилил(?:ся|ивается)|продолжает(?:ся)?)|(?<!не )(?:пош[её]л|ш[её]л|начался|ль[её]т|лил|ид[её]т|проливной)\s+(?:(?:сильный|мелкий|т[её]плый|холодный)\s+)?(?:дождь|ливень)|на улице\s+(?:вс[её] ещ[её]\s+)?(?:дождь|ливень)(?!\p{L})|капли\s+дождя\s+(?:стуч\p{L}*|барабан\p{L}*|пада\p{L}*)|под\s+(?:проливным\s+)?дожд[её]м)/giu],
  ["rain", /\b(?:it's|it is|it was)\s+(?:still\s+)?raining\b|\b(?:rain|the downpour)\s+(?:(?:still|now)\s+)?(?:falls|fell|pours|poured|beats|patters|drums|starts|started|begins|began|continues|continued)\b|\b(?:starts|started|begins|began)\s+to\s+rain\b/giu],
  ["dry", /(?<!\p{L})(?:(?:дождь|ливень)\s+(?:стих\p{L}*|прекра(?:тил|ща)\p{L}*|законч\p{L}*|переста\p{L}*|утих\p{L}*|не ид[её]т)|не\s+ид[её]т\s+дождь|(?:перестал(?:о)?\s+(?:лить|моросить)|дождя\s+(?:больше\s+)?нет))/giu],
  ["dry", /\b(?:rain|downpour)\s+(?:(?:has|had|finally)\s+)*(?:stops|stopped|ends|ended|eases|eased|lets up|let up|clears|cleared)\b|\b(?:stopped raining|no longer raining)\b/giu],
];

const HYPOTHETICAL_OR_PAST = /(?:^|[^\p{L}])(?:если|мог(?:ли|ла)? бы|может быть|наверное|завтра|вчера|накануне|раньше|когда-то|вспомнил\p{L}*|вспомина\p{L}*|представил\p{L}*|приснил\p{L}*|будет|обещали|(?:сказал|ответил|уточнил)\p{L}*,?\s+что)(?=$|[^\p{L}])|\b(?:if|would|might|maybe|tomorrow|yesterday|earlier|used to|remember\w*|imagin\w*|dream\w*|forecast)\b/iu;
const DIALOGUE_LINE = /^\s*(?:[—–-]\s|>\s|(?:\*{1,2})?[\p{L}\p{N}][\p{L}\p{N} .'-]{0,30}(?:\*{1,2})?:)/u;

function sceneText(content: string) {
  const choices = splitStoryChoices(content);
  return (choices ? `${choices.before}\n${choices.after}` : content)
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`\n]*`|«[^»]*»|“[^”]*”|"[^"\n]*"/g, "")
    .split("\n")
    .map(line => DIALOGUE_LINE.test(line)
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
    for (const sentence of sceneText(content).split(/[.!?…;\n]+/)) {
      if (HYPOTHETICAL_OR_PAST.test(sentence)) continue;
      const events = CUES.flatMap(([cue, pattern]) => Array.from(sentence.matchAll(pattern), match => ({
        cue,
        index: match.index,
      }))).sort((a, b) => a.index - b.index);
      for (const { cue } of events) {
        if (cue === "rain") rain = true;
        else if (cue === "dry") rain = false;
        else {
          indoors = cue === "inside" || cue === "tavern";
          place = cue === "inside" || cue === "outside" ? null : cue;
        }
      }
    }
  }
  return rain && !indoors ? "rain" : place;
}
