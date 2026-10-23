import type { Locale } from "@/lib/i18nConfig";
import { MAX_GROUP_PARTICIPANTS } from "@/lib/roleplayConfig";

/**
 * Server-rendered search copy for the home catalog and the /create landing page.
 * Kept out of common.json like GENRE_INTROS: only these pages render it.
 * Every claim here must stay true for the product (free quota, sign-up, avatars).
 */
export type Faq = { question: string; answer: string };

type HomeAbout = { heading: string; paragraphs: string[]; createLink: string; genresLink: string; faqHeading: string; faq: Faq[] };

const FREE_ANSWER: Record<Locale, { quota: string; noQuota: string }> = {
  ru: {
    quota: "Да. Первые сообщения можно отправить без регистрации, а после входа в аккаунт каждый день доступны бесплатные ответы на базовой модели. Подписка добавляет больше бесплатных ответов, бонусные VerseCoins и увеличенную память контекста.",
    noQuota: "Начать можно бесплатно: первые сообщения доступны без регистрации. Дальше ответы оплачиваются VerseCoins или подпиской.",
  },
  en: {
    quota: "Yes. You can send your first messages without signing up, and once you have an account you get free replies on the base model every day. A plan adds more free replies, bonus VerseCoins and a larger context window.",
    noQuota: "You can start for free: the first messages need no sign-up. After that, replies are paid with VerseCoins or a plan.",
  },
};

const HOME_ABOUT: Record<Locale, Omit<HomeAbout, "faq"> & { faq: (freeQuota: boolean) => Faq[] }> = {
  ru: {
    heading: "Чат с ИИ-персонажами на русском",
    paragraphs: [
      "NewVerse — сайт для общения с ИИ-персонажами. В каталоге герои разных жанров: романтика, фэнтези, аниме, детективы, научная фантастика и спокойная повседневность. Выберите персонажа по описанию и характеру, откройте чат и начните переписку — он ответит в своём стиле, со своей историей и манерой речи.",
      "Это не просто ИИ-чат с вопросами и ответами, а ролевые игры с ИИ. У каждого героя есть завязка, мир и первое сообщение, с которого начинается сцена. Вы решаете, кем быть в этой истории и куда её повернуть. Персонажи запоминают важные детали разговора, поэтому к истории можно вернуться через день или неделю и продолжить с того же места.",
      "Если подходящего героя нет, создайте своего ИИ-персонажа: задайте характер, внешность, первое сообщение и мир, а потом общайтесь с ним сами или опубликуйте его в каталоге. Сайт работает на русском и английском, а начать можно без регистрации.",
    ],
    createLink: "Создать ИИ-персонажа",
    genresLink: "Все жанры",
    faqHeading: "Частые вопросы",
    faq: (freeQuota) => [
      { question: "Можно ли общаться с ИИ-персонажами бесплатно?", answer: FREE_ANSWER.ru[freeQuota ? "quota" : "noQuota"] },
      { question: "Нужна ли регистрация?", answer: "Нет. Чтобы попробовать, достаточно открыть персонажа и написать первое сообщение. Аккаунт нужен, чтобы сохранять истории, продолжать их с другого устройства и создавать своих персонажей." },
      { question: "Персонажи помнят, о чём мы говорили?", answer: "Да. Персонаж учитывает недавние сообщения и запоминает важные факты из разговора: имена, договорённости, события сюжета. Поэтому историю можно продолжить с того места, где вы остановились." },
      { question: "На каком языке можно общаться?", answer: "На русском или английском. У персонажей есть описания на обоих языках, а переключить язык сайта можно в меню." },
      { question: "Чем ролевая игра с ИИ отличается от обычного чат-бота?", answer: "Обычный чат-бот отвечает на вопросы. ИИ-персонаж играет роль: у него есть характер, прошлое и цели, он реагирует на ваши поступки и вместе с вами развивает сюжет." },
    ],
  },
  en: {
    heading: "Chat with AI characters",
    paragraphs: [
      "NewVerse is a place to talk with AI characters. The catalog has heroes from many genres: romance, fantasy, anime, detective stories, science fiction and calm everyday life. Pick a character by their description and personality, open the chat and start writing — they reply in their own voice, with their own story and way of speaking.",
      "This is more than an AI chat with questions and answers: it is AI roleplay. Every character comes with a setup, a world and a first message that opens the scene. You decide who you are in the story and where it goes. Characters remember the important details of the conversation, so you can come back a day or a week later and continue where you left off.",
      "If you cannot find the right hero, create your own AI character: set their personality, appearance, first message and world, then chat with them yourself or publish them to the catalog. The site works in English and Russian, and you can start without signing up.",
    ],
    createLink: "Create an AI character",
    genresLink: "All genres",
    faqHeading: "Frequently asked questions",
    faq: (freeQuota) => [
      { question: "Can I chat with AI characters for free?", answer: FREE_ANSWER.en[freeQuota ? "quota" : "noQuota"] },
      { question: "Do I need to sign up?", answer: "No. To try it, open a character and write your first message. An account lets you save your stories, continue them on another device and create your own characters." },
      { question: "Do characters remember what we talked about?", answer: "Yes. A character keeps track of recent messages and remembers important facts from the conversation: names, promises, plot events. So you can pick the story up where you left it." },
      { question: "Which languages can I use?", answer: "English or Russian. Characters have descriptions in both languages, and you can switch the site language in the menu." },
      { question: "How is AI roleplay different from a regular chatbot?", answer: "A regular chatbot answers questions. An AI character plays a role: they have a personality, a past and goals, react to what you do and build the plot together with you." },
    ],
  },
};

export function homeAbout(locale: Locale, freeQuota: boolean): HomeAbout {
  const text = HOME_ABOUT[locale];
  return { ...text, faq: text.faq(freeQuota) };
}

export type CreateLanding = {
  eyebrow: string;
  h1: string;
  intro: string;
  modesHeading: string;
  modesHint: string;
  stepsHeading: string;
  steps: { title: string; text: string }[];
  featuresHeading: string;
  features: { title: string; text: string }[];
  faqHeading: string;
  faq: Faq[];
};

export const CREATE_LANDING: Record<Locale, CreateLanding> = {
  ru: {
    eyebrow: "Конструктор персонажей NewVerse",
    h1: "Создать ИИ-персонажа",
    intro: "Придумайте героя для общения и ролевых игр с ИИ: задайте характер, внешность, первое сообщение и мир, в котором он живёт. Создание бесплатное — нужен только аккаунт.",
    modesHeading: "Что создаём?",
    modesHint: "Достаточно основной идеи. Внешность, манеру общения и детали истории можно дополнить позже.",
    stepsHeading: "Как создать ИИ-персонажа",
    steps: [
      { title: "Выберите формат", text: `Один персонаж, целая вселенная, где вы главный герой, или общая история с составом до ${MAX_GROUP_PARTICIPANTS} персонажей.` },
      { title: "Опишите героя", text: "Имя, характер, внешность и манеру речи. Начните с того, что делает героя узнаваемым: привычки, цель, одна яркая черта." },
      { title: "Задайте начало истории", text: "Первое сообщение и сценарий: где происходит встреча и с чего начинается сцена. Примеры диалогов помогут персонажу точнее держать стиль." },
      { title: "Сохраните и начните чат", text: "Оставьте персонажа приватным или опубликуйте его в каталоге, чтобы с ним могли общаться другие." },
    ],
    featuresHeading: "Что можно настроить",
    features: [
      { title: "Характер и мотивы", text: "Чего герой хочет, чего боится и как относится к собеседнику." },
      { title: "Внешность и аватар", text: "Загрузите своё изображение или сгенерируйте аватар по описанию — генерация входит в подписку." },
      { title: "Манера речи", text: "Короткие реплики или развёрнутые ответы, сленг, вежливость, акцент." },
      { title: "Мир и правила", text: "Место действия, второстепенные персонажи и правила повествования для вселенных." },
      { title: "Жанры и теги", text: "По ним персонажа находят в каталоге и на страницах жанров." },
      { title: "Память", text: "Что персонаж знает о себе и о собеседнике с первой реплики." },
    ],
    faqHeading: "Частые вопросы о создании персонажа",
    faq: [
      { question: "Сколько стоит создать ИИ-персонажа?", answer: "Создание персонажа бесплатное. Генерация аватара по описанию входит в подписку; без неё можно загрузить своё изображение." },
      { question: "Нужна ли регистрация?", answer: "Да: персонажи сохраняются в аккаунте, поэтому для создания нужно войти. Пообщаться с готовыми персонажами из каталога можно и без регистрации." },
      { question: "Можно ли сделать персонажа приватным?", answer: "Да. Приватного персонажа видите только вы. Публичный появляется в каталоге и доступен всем; он должен соответствовать правилам платформы." },
      { question: "Как сделать, чтобы персонаж отвечал интереснее?", answer: "Опишите не только внешность, но и мотивы, привычки и манеру речи. Добавьте первое сообщение с конкретной сценой и один-два примера диалога: чем яснее завязка, тем живее ответы." },
      { question: "Можно ли изменить персонажа после создания?", answer: "Да. Карточку можно редактировать в любой момент: дополнить описание, сменить аватар или первое сообщение." },
    ],
  },
  en: {
    eyebrow: "NewVerse character creator",
    h1: "Create an AI character",
    intro: "Design a hero for AI chat and roleplay: set their personality, appearance, first message and the world they live in. Creating a character is free — you only need an account.",
    modesHeading: "What are we creating?",
    modesHint: "A core idea is enough. Appearance, speaking style and story details can be added later.",
    stepsHeading: "How to create an AI character",
    steps: [
      { title: "Pick a format", text: `A single character, a whole universe where you are the main hero, or a shared story with a cast of up to ${MAX_GROUP_PARTICIPANTS} characters.` },
      { title: "Describe the hero", text: "Name, personality, appearance and way of speaking. Start with what makes the hero recognisable: a habit, a goal, one striking trait." },
      { title: "Set how the story begins", text: "A first message and a scenario: where the meeting happens and how the scene opens. Example dialogues help the character keep their style." },
      { title: "Save and start chatting", text: "Keep the character private or publish them to the catalog so others can chat with them too." },
    ],
    featuresHeading: "What you can set up",
    features: [
      { title: "Personality and motives", text: "What the hero wants, what they fear and how they treat the person they talk to." },
      { title: "Appearance and avatar", text: "Upload your own image or generate an avatar from the description — generation is included in a plan." },
      { title: "Speaking style", text: "Short lines or long replies, slang, politeness, an accent." },
      { title: "World and rules", text: "The setting, supporting characters and narrative rules for universes." },
      { title: "Genres and tags", text: "They help people find the character in the catalog and on genre pages." },
      { title: "Memory", text: "What the character knows about themselves and about you from the first line." },
    ],
    faqHeading: "Questions about creating a character",
    faq: [
      { question: "How much does it cost to create an AI character?", answer: "Creating a character is free. Generating an avatar from the description is included in a plan; without one you can upload your own image." },
      { question: "Do I need to sign up?", answer: "Yes: characters are saved to your account, so you need to sign in to create one. You can chat with catalog characters without signing up." },
      { question: "Can I keep a character private?", answer: "Yes. Only you can see a private character. A public one appears in the catalog for everyone and must follow the platform rules." },
      { question: "How do I make a character's replies more interesting?", answer: "Describe not only their looks but also their motives, habits and way of speaking. Add a first message with a concrete scene and one or two example dialogues: the clearer the setup, the livelier the replies." },
      { question: "Can I change a character after creating it?", answer: "Yes. You can edit the card at any time: extend the description, change the avatar or the first message." },
    ],
  },
};
