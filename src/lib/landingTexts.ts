import type { Locale } from "@/lib/i18nConfig";
import { localizedValue } from "@/lib/getDictionary";
import { MAX_GROUP_PARTICIPANTS } from "@/lib/roleplayConfig";

export type Faq = { question: string; answer: string };
type HomeAbout = { heading: string; paragraphs: string[]; createLink: string; genresLink: string; faqHeading: string; faq: Faq[] };
export function homeAbout(locale: Locale, freeQuota: boolean): HomeAbout {
  const text = localizedValue<HomeAbout>(locale, "landing.home");
  const answer = localizedValue<string>(locale, `landing.freeAnswer.${freeQuota ? "quota" : "noQuota"}`);
  return { ...text, faq: text.faq.map((item) => ({ ...item, answer: item.answer.replaceAll("{{freeAnswer}}", answer) })) };
}
export type CreateLanding = {
  eyebrow: string; h1: string; intro: string; modesHeading: string; modesHint: string;
  stepsHeading: string; steps: { title: string; text: string }[];
  featuresHeading: string; features: { title: string; text: string }[]; faqHeading: string; faq: Faq[];
};
export function createLanding(locale: Locale): CreateLanding {
  const text = localizedValue<CreateLanding>(locale, "landing.create");
  return { ...text, steps: text.steps.map((step) => ({ ...step, text: step.text.replaceAll("{{maxParticipants}}", String(MAX_GROUP_PARTICIPANTS)) })) };
}
