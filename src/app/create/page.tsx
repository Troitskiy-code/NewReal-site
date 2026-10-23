import Footer from "@/components/Footer";
import LandingFaq from "@/components/LandingFaq";
import RoleplayModeCards from "@/components/RoleplayModeCards";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { CREATE_LANDING } from "@/lib/landingTexts";
import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("create");
}

/** Mode picker and the search landing page for "создать ИИ-персонажа"; the editor itself needs sign-in. */
export default async function CreateSelectionPage() {
  const text = CREATE_LANDING[await getRequestLocale()];
  return <div className="flex min-h-dvh flex-col bg-[#0c0b12] text-white">
    <main className="flex-1 px-4 py-8 sm:px-6 md:py-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <header className="space-y-3">
          <p className="text-sm font-medium text-wd-secondary-text">{text.eyebrow}</p>
          <h1 className="text-2xl font-bold sm:text-3xl">{text.h1}</h1>
          <p className="max-w-2xl text-base leading-relaxed text-[#a9a4b8]">{text.intro}</p>
        </header>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold sm:text-xl">{text.modesHeading}</h2>
          <RoleplayModeCards />
          <p className="text-sm text-[#a9a4b8]">{text.modesHint}</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold sm:text-xl">{text.stepsHeading}</h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {text.steps.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-[#2a2638] bg-wd-card p-4">
                <span className="text-xs font-semibold text-wd-secondary-text">{index + 1}</span>
                <h3 className="mt-1 text-[15px] font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#a9a4b8]">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold sm:text-xl">{text.featuresHeading}</h2>
          <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {text.features.map((feature) => (
              <li key={feature.title}>
                <h3 className="text-[15px] font-semibold">{feature.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-[#a9a4b8]">{feature.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <div className="max-w-3xl">
          <LandingFaq heading={text.faqHeading} items={text.faq} />
        </div>
      </div>
    </main>
    <Footer />
  </div>;
}
