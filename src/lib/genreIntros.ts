import type { Locale } from "@/lib/i18nConfig";
import type { GenreId } from "@/lib/genreSeo";

/**
 * Server-rendered intro paragraphs for genre landing pages. Kept out of common.json:
 * the dictionaries ship to every client bundle and only these pages render this copy.
 */
export const GENRE_INTROS: Record<GenreId, Record<Locale, string[]>> = {
  fantasy: {
    ru: [
      "Фэнтези — жанр, где разговор с персонажем легко превращается в целое странствие. Здесь живут маги и наёмники, эльфийские стражи, драконьи всадники, ведьмы с окраин королевства и студенты магических академий. Вы можете войти в историю как спутник героя, его соперник или случайный путник, которому досталась опасная тайна.",
      "ИИ-персонаж отвечает в духе своего мира: у него есть свои клятвы, страхи и представления о чести. Одни сюжеты начинаются у костра в таверне, другие — на поле битвы или в библиотеке запретных заклинаний. Выбирайте персонажа по описанию и характеру, задавайте тон сцены — от уютной сказки до мрачной истории о цене могущества — и решайте сами, чем закончится поход.",
    ],
    en: [
      "Fantasy is where a conversation with a character easily turns into a whole journey. This is home to mages and mercenaries, elven guards, dragon riders, hedge witches from the edge of the kingdom and students at magic academies. You can step into the story as the hero's companion, their rival, or a passing traveller who has stumbled onto a dangerous secret.",
      "An AI character answers in the voice of their world: they have their own oaths, fears and ideas about honour. Some stories begin by a tavern fire, others on a battlefield or in a library of forbidden spells. Pick a character by their description and personality, set the tone of the scene — from a cosy fairy tale to a grim story about the price of power — and decide for yourself how the quest ends.",
    ],
  },
  romance: {
    ru: [
      "Романтические персонажи — для историй, где главное происходит между двумя людьми. Это может быть неспешное знакомство с соседом по дому, напряжённая игра с давним соперником, служебный роман, письма из другой эпохи или чувства, которые герой пока не готов признать даже себе.",
      "У каждого персонажа свой характер: кто-то заботлив и открыт, кто-то сдержан и раскрывается медленно, кто-то флиртует с первой реплики. Темп задаёте вы — от лёгкого флирта до истории с медленным развитием отношений, где доверие нужно заслужить. Персонаж отвечает на ваши слова и поступки, поэтому один и тот же сюжет может закончиться признанием, ссорой или новой главой. Выберите героя по описанию, начните с его приветственной сцены или придумайте собственную завязку.",
    ],
    en: [
      "Romance characters are for stories where what matters most happens between two people. It might be a slow acquaintance with a neighbour down the hall, a charged game with an old rival, an office romance, letters from another era, or feelings the character is not ready to admit even to themselves.",
      "Every character has a personality of their own: some are warm and open, some are reserved and take time to open up, some flirt from the very first line. You set the pace, from light flirting to a slow-burn relationship where trust has to be earned. The character responds to what you say and do, so the same story can end in a confession, a quarrel or a new chapter. Choose someone by their description, start with their opening scene, or write your own.",
    ],
  },
  anime: {
    ru: [
      "Аниме-персонажей узнаёшь с первого взгляда: яркая внешность, выразительные эмоции и характеры, знакомые по любимым тайтлам, — цундере, невозмутимые отличники, хулиганы с добрым сердцем, загадочные новенькие в классе. Но истории здесь не ограничены школьными коридорами.",
      "В этом разделе собраны персонажи в аниме-стилистике из самых разных сюжетов: школьная повседневность и клубы после уроков, магические академии, исекай с попаданием в другой мир, спортивное соперничество, романтика и приключения. Персонаж держится своей роли и реагирует на ваши решения, так что можно разыграть и тёплую сцену на крыше школы, и напряжённый поединок. Выберите героя по карточке, прочитайте описание и начните с готовой сцены — или предложите свою завязку, будто пишете новую серию.",
    ],
    en: [
      "Anime characters are recognisable at a glance: vivid looks, expressive emotions and familiar archetypes — tsunderes, unflappable top students, troublemakers with good hearts, the mysterious new kid in class. But the stories here go well beyond school corridors.",
      "This section gathers anime-style characters from all kinds of plots: everyday school life and after-class clubs, magic academies, isekai adventures in another world, sports rivalries, romance and quests. Each character stays true to their role and reacts to your choices, so you can play out a quiet scene on the school roof or a tense duel. Pick a character from their card, read their description and begin with the ready-made scene, or suggest your own setup as if you were writing a new episode.",
    ],
  },
  scifi: {
    ru: [
      "Научная фантастика на NewVerse — это истории о будущем, технологиях и людях, которые в нём оказались. Капитаны звёздных кораблей, андроиды, которые учатся быть людьми, учёные на далёких станциях, пилоты, контрабандисты и первые свидетели контакта с иным разумом.",
      "Здесь можно отправиться в долгий космический рейс, расследовать сбой в системах колонии или спорить с искусственным интеллектом о том, что такое память и свобода выбора. Персонажи держатся правил своего мира: у корабля кончается топливо, у станции есть устав, а у андроида — протоколы, которые он, возможно, захочет нарушить. Задавайте вопросы, принимайте рискованные решения и смотрите, куда приведёт сюжет. Если хочется больше технологий и неона на улицах, загляните и в раздел киберпанка.",
    ],
    en: [
      "Science fiction on NewVerse is about the future, technology and the people caught up in it: starship captains, androids learning to be human, scientists on distant stations, pilots, smugglers and the first witnesses of contact with an alien mind.",
      "You can set off on a long deep-space voyage, investigate a failure in a colony's systems, or argue with an artificial intelligence about memory and free will. Characters keep to the rules of their world: the ship runs low on fuel, the station has its regulations, and the android has protocols it may decide to break. Ask questions, take risky decisions and see where the plot leads. If you want more street-level tech and neon, the cyberpunk section is right next door.",
    ],
  },
  mystic: {
    ru: [
      "Мистика — для тех, кого тянет к необъяснимому. Здесь вас ждут гадалки и медиумы, хранители старых домов, проклятые аристократы, ведьмы, духи и люди, которые слишком много знают о чужих снах.",
      "Мистические истории строятся на недосказанности: персонаж может говорить загадками, скрывать часть правды или проверять, готовы ли вы услышать её целиком. Сцены начинаются в полуночном поезде, на спиритическом сеансе, в заброшенной усадьбе или в маленьком городке, где у каждого жителя есть тайна. В отличие от ужасов, здесь важнее атмосфера и разгадка, чем страх, хотя граница бывает тонкой. Выберите персонажа по описанию, прислушайтесь к его намёкам и решите, стоит ли открывать дверь, за которой кто-то ждёт.",
    ],
    en: [
      "Mystery and the supernatural are for anyone drawn to the unexplained. Here you will meet fortune-tellers and mediums, keepers of old houses, cursed aristocrats, witches, spirits and people who know far too much about other people's dreams.",
      "These stories live on what is left unsaid: a character may speak in riddles, hide part of the truth, or test whether you are ready to hear all of it. Scenes open on a midnight train, at a séance, in an abandoned manor or in a small town where every resident keeps a secret. Unlike horror, atmosphere and the solution matter more than fear here, though the line can be thin. Choose a character by their description, listen to their hints and decide whether to open the door someone is waiting behind.",
    ],
  },
  realistic: {
    ru: [
      "Персонажи современного мира живут почти как мы: учатся, работают, снимают квартиры, ходят в кофейни и попадают в истории, которые могли бы случиться с кем угодно. Это коллеги и соседи, звёзды и их менеджеры, врачи, студенты, бариста, музыканты и бывшие одноклассники.",
      "Сила таких ролевых игр — в правдоподобии. Без магии и звездолётов на первый план выходят характер, диалог и отношения: неловкая встреча после долгой разлуки, трудный разговор с начальником, первое свидание или помощь другу в тяжёлый вечер. Персонаж отвечает с учётом своего прошлого и привычек, а сюжет развивается от ваших слов и решений. Такие истории подходят и для лёгкой беседы, и для серьёзной драмы. Выберите героя по описанию и начните с готовой сцены или с того, что произошло с вами сегодня.",
    ],
    en: [
      "Modern-day characters live much like we do: they study, work, rent flats, meet in coffee shops and get caught up in stories that could happen to anyone. They are colleagues and neighbours, stars and their managers, doctors, students, baristas, musicians and old classmates.",
      "The strength of this kind of roleplay is that it feels true to life. Without magic or starships, personality, dialogue and relationships take centre stage: an awkward reunion after years apart, a hard conversation with a boss, a first date, or helping a friend through a rough evening. The character answers with their own past and habits in mind, and the plot grows from your words and choices. These stories suit both a light chat and a serious drama. Pick a character by their description and start with their scene or with something that happened to you today.",
    ],
  },
  adventure: {
    ru: [
      "Приключения — это движение: дорога, карта с белыми пятнами и спутник, с которым не заскучаешь. В этом жанре собраны искатели сокровищ, пираты, следопыты, наёмники, путешественники во времени и герои, которые всегда оказываются там, где начинаются неприятности.",
      "Любая сцена может повернуть сюжет: погоня по крышам, переправа через бурную реку, сделка с подозрительным торговцем или древний механизм, который нужно открыть до заката. Персонаж реагирует на ваши решения — поддержит рискованный план, начнёт спорить или неожиданно предложит свой. Приключения легко сочетаются с другими жанрами: фэнтезийным походом, космической экспедицией или поиском пропавшего друга в современном городе. Выберите напарника по описанию, договоритесь о цели и отправляйтесь в путь — маршрут сложится по ходу истории.",
    ],
    en: [
      "Adventure is about motion: the open road, a map with blank spaces and a companion who will not let things get dull. This genre brings together treasure hunters, pirates, trackers, mercenaries, time travellers and heroes who always end up exactly where trouble begins.",
      "Any scene can turn the plot: a rooftop chase, a crossing over a raging river, a deal with a suspicious merchant, or an ancient mechanism that must be opened before sunset. The character reacts to your decisions — backs a risky plan, argues, or suddenly proposes one of their own. Adventure mixes easily with other genres: a fantasy quest, a space expedition or the search for a missing friend in a modern city. Choose a companion by their description, agree on a goal and set off; the route will take shape as the story goes.",
    ],
  },
  detective: {
    ru: [
      "Детективные персонажи — для тех, кто любит улики, допросы и неожиданные развязки. Здесь можно встретить частных сыщиков и усталых следователей, журналистов-расследователей, хладнокровных преступников и свидетелей, которые явно что-то недоговаривают.",
      "Вы можете вести расследование вместе с персонажем, оказаться под подозрением или играть против него, пытаясь поймать на противоречиях. Хорошая детективная сцена держится на деталях: время на часах, след на подоконнике, оговорка в разговоре. Персонаж учитывает то, что уже прозвучало в беседе, поэтому внимательный игрок может сопоставить показания и прийти к собственной версии. Сюжеты бывают классическими — с запертой комнатой и кругом подозреваемых — и современными, с камерами наблюдения и перепиской в мессенджерах. Выберите героя и задайте первый вопрос.",
    ],
    en: [
      "Detective characters are for anyone who loves clues, interrogations and unexpected twists. Here you will find private investigators and weary police detectives, investigative journalists, cold-blooded criminals and witnesses who are clearly holding something back.",
      "You can work a case alongside the character, end up as a suspect yourself, or play against them and try to catch them in a contradiction. A good detective scene runs on details: the time on a clock, a mark on a windowsill, a slip of the tongue. The character keeps track of what has already been said, so an attentive player can compare statements and reach their own theory. Cases can be classic, with a locked room and a circle of suspects, or modern, with security cameras and message threads. Choose a character and ask the first question.",
    ],
  },
  everyday: {
    ru: [
      "Повседневность — жанр небольших историй, из которых складывается жизнь: утренний кофе с соседкой, смена в книжном магазине, совместная подготовка к экзаменам, переезд, долгий разговор на кухне.",
      "Здесь не нужно спасать мир. Ценность таких ролевых игр — в живом общении и постепенном развитии отношений: персонаж подмечает детали, шутит, делится планами, может поддержать после тяжёлого дня или позвать в спонтанную поездку. Среди героев — друзья, соседи по комнате, коллеги и знакомые, с которыми хочется поговорить ещё. Повседневные сюжеты хорошо подходят, если вы хотите отдохнуть, попрактиковаться в диалоге или просто провести вечер в спокойной компании. Выберите персонажа по характеру, начните с обычной сцены и позвольте истории развиваться без спешки.",
    ],
    en: [
      "Slice of life is the genre of small stories that make up a life: morning coffee with a neighbour, a shift at a bookshop, studying for exams together, moving house, a long talk in the kitchen.",
      "Nobody has to save the world here. The value of this kind of roleplay is in natural conversation and relationships that grow over time: the character picks up on details, jokes, shares plans, can support you after a hard day or invite you on a spontaneous trip. The cast includes friends, roommates, colleagues and acquaintances you will want to talk to again. Slice-of-life stories are a good fit when you want to unwind, practise conversation or simply spend an evening in calm company. Pick a character by their personality, start with an ordinary scene and let the story unfold without hurry.",
    ],
  },
  cyberpunk: {
    ru: [
      "Киберпанк — это неоновые улицы, корпорации сильнее государств и люди, которые продают память, тело и верность за шанс выжить. В этом жанре вас ждут хакеры, наёмники с имплантами, уличные доктора, детективы мегаполиса и андроиды, которые начали сомневаться в своих протоколах.",
      "Сюжеты здесь жёсткие и быстрые: взлом защищённой сети, сделка в подпольном клубе, побег от корпоративной службы безопасности, поиск того, кто стёр часть вашего прошлого. Персонаж живёт по законам своего города — может предать за хорошую цену, а может рискнуть всем ради напарника. Киберпанк близок к научной фантастике, но смотрит не в космос, а вниз, на улицы, где технологии стали обычным товаром. Выберите персонажа по описанию, решите, на чьей вы стороне, и заключите первую сделку.",
    ],
    en: [
      "Cyberpunk means neon streets, corporations more powerful than governments and people who sell their memories, bodies and loyalty for a chance to survive. This genre is home to hackers, augmented mercenaries, back-alley doctors, big-city detectives and androids who have started to doubt their protocols.",
      "The stories are hard and fast: cracking a secured network, a deal in an underground club, an escape from corporate security, the hunt for whoever erased part of your past. The character lives by the rules of their city — they might sell you out for the right price, or risk everything for a partner. Cyberpunk is close to science fiction, but instead of looking up at the stars it looks down at the streets, where technology has become an everyday commodity. Choose a character by their description, decide whose side you are on and make your first deal.",
    ],
  },
  horror: {
    ru: [
      "Ужасы — для тех, кто любит, когда по спине пробегает холодок. Здесь собраны персонажи, рядом с которыми безопасность всегда под вопросом: монстры и их жертвы, охотники на нечисть, обитатели заброшенных больниц, выжившие после катастрофы и существа, которые лишь притворяются людьми.",
      "Хорошая хоррор-история строится на напряжении, а не на количестве крови. Скрип половиц, фонарь, который вот-вот погаснет, голос из соседней комнаты — персонаж ведёт сцену так, чтобы вы сами решали, идти дальше или бежать. Можно играть за того, кто расследует пропажу, за случайного гостя в чужом доме или вступить в опасный разговор с самим чудовищем. Уровень жути задаёте вы: от атмосферной готики до настоящего выживания. Выберите персонажа по описанию и выключите свет.",
    ],
    en: [
      "Horror is for those who enjoy a chill running down their spine. This section gathers characters around whom safety is never guaranteed: monsters and their victims, hunters of the unholy, residents of abandoned hospitals, survivors of a disaster and creatures that only pretend to be human.",
      "A good horror story is built on tension, not on the amount of blood. A creaking floorboard, a torch about to go out, a voice from the next room — the character runs the scene so that you decide whether to go further or run. You can play the one investigating a disappearance, an unlucky guest in a stranger's house, or step into a dangerous conversation with the monster itself. You choose how frightening it gets, from atmospheric gothic to real survival. Pick a character by their description and turn off the lights.",
    ],
  },
  comedy: {
    ru: [
      "Комедийные персонажи — для тех случаев, когда хочется не драмы, а смеха. Это ироничные напарники, неуклюжие волшебники, самоуверенные злодеи, у которых никогда ничего не получается, болтливые соседи и герои, попадающие в абсурдные ситуации на ровном месте.",
      "Юмор в ролевой игре рождается из характера: персонаж остаётся собой, даже когда всё идёт наперекосяк, и именно это делает сцену смешной. Можно разыграть неудачное свидание, бытовой хаос в общей квартире, пародию на эпическое приключение или спор с котом, который считает себя королём. Персонаж подхватывает ваши шутки, отвечает своими и охотно доводит ситуацию до абсурда, если вы этого хотите. Комедия хорошо сочетается с повседневностью, фэнтези и романтикой. Выберите героя, придумайте нелепую завязку и посмотрите, что из этого выйдет.",
    ],
    en: [
      "Comedy characters are for when you want laughter rather than drama: witty sidekicks, clumsy wizards, overconfident villains whose plans never work, chatty neighbours and heroes who stumble into absurd situations out of nowhere.",
      "Humour in roleplay comes from personality: the character stays true to themselves even when everything goes sideways, and that is exactly what makes a scene funny. You can play out a disastrous date, domestic chaos in a shared flat, a parody of an epic quest, or an argument with a cat who believes it is royalty. The character picks up your jokes, answers with their own and will happily push things to the absurd if that is what you want. Comedy pairs well with slice of life, fantasy and romance. Choose a character, set up a ridiculous premise and see what happens.",
    ],
  },
  drama: {
    ru: [
      "Драма — жанр историй о выборе, утрате, вине и прощении. Здесь персонажи с непростым прошлым: люди, потерявшие близких, бывшие друзья, которых развела жизнь, герои перед трудным решением, семьи, где многое осталось невысказанным.",
      "Драматические ролевые игры требуют времени и внимания: персонаж раскрывается не сразу, и доверие нужно заслужить. Сцена может начаться с короткой встречи на вокзале или с письма, которое пришло слишком поздно, а дальше всё зависит от того, что вы скажете и о чём промолчите. ИИ-персонаж отвечает с учётом своих ран и мотивов, поэтому разговор способен привести и к примирению, и к окончательному разрыву. Если вам близки истории, после которых хочется помолчать, выберите героя по описанию и начните с честного вопроса.",
    ],
    en: [
      "Drama is the genre of stories about choice, loss, guilt and forgiveness. The characters here carry a difficult past: people who have lost someone close, former friends driven apart by life, heroes facing a hard decision, families where much has been left unsaid.",
      "Dramatic roleplay takes time and attention: the character does not open up at once, and trust has to be earned. A scene may begin with a brief meeting at a railway station or a letter that arrived too late, and from there everything depends on what you say and what you leave unspoken. The AI character answers in light of their wounds and motives, so the conversation can lead to reconciliation or to a final parting. If you are drawn to stories that leave you quiet for a while afterwards, choose a character by their description and start with an honest question.",
    ],
  },
};
