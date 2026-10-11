import Footer from "@/components/Footer";
import RoleplayModeCards from "@/components/RoleplayModeCards";

export default function CreateSelectionPage() {
  return <div className="flex min-h-dvh flex-col bg-[#121212] text-white">
    <main className="flex-1 px-4 py-8 sm:px-6 md:py-12">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="space-y-3">
          <p className="text-sm font-medium text-wd-secondary-text">Ваша следующая история</p>
          <h1 className="text-2xl font-bold sm:text-3xl">Что создаём?</h1>
          <p className="max-w-2xl text-base leading-relaxed text-[#A0A0A0]">Выберите формат — затем откроется редактор с подходящими полями.</p>
        </header>
        <RoleplayModeCards />
        <p className="text-sm text-[#A0A0A0]">Достаточно основной идеи. Внешность, манеру общения и детали истории можно дополнить позже.</p>
      </div>
    </main>
    <Footer />
  </div>;
}
