import LocaleLink from "@/components/LocaleLink";

export default function TelegramCatalogAdmin() {
  return <main className="mx-auto max-w-3xl px-4 py-8">
    <h1 className="mb-4 text-2xl font-bold">Каталог Telegram</h1>
    <p className="mb-4 text-wd-text-secondary">
      В Telegram доступен весь публичный каталог NewVerse. Новые публичные персонажи
      появляются автоматически, отдельная подборка больше не требуется.
    </p>
    <p className="mb-6 text-wd-text-secondary">
      Приватные персонажи доступны только их авторам. Публикацией можно управлять
      в редакторе персонажа — настройка действует и на сайте, и в Telegram.
    </p>
    <LocaleLink href="/" className="wd-btn">Открыть публичный каталог</LocaleLink>
  </main>;
}
