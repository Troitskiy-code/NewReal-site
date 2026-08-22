import Link from "next/link";
import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="border-t border-wd-border bg-wd-bg px-4 py-6 text-center">
      <Logo size="md" className="mb-2 inline-block" />
      <nav className="mb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
        <Link href="/offer" className="text-wd-text-secondary transition-colors hover:text-white">
          Публичная оферта
        </Link>
        <Link href="/terms" className="text-wd-text-secondary transition-colors hover:text-white">
          Пользовательское соглашение
        </Link>
        <Link href="/refund" className="text-wd-text-secondary transition-colors hover:text-white">
          Политика возврата
        </Link>
        <Link href="/support" className="text-wd-text-secondary transition-colors hover:text-white">
          Поддержка
        </Link>
      </nav>
      <p className="text-xs text-wd-text-secondary">
        © {new Date().getFullYear()} NewVerse — Твоя вселенная персонажей
      </p>
    </footer>
  );
}
