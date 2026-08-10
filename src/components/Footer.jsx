import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="border-t border-wd-border bg-wd-bg px-4 py-6 text-center">
      <Logo size="md" className="inline-block mb-2" />
      <p className="text-xs text-wd-text-secondary">
        © {new Date().getFullYear()} NewReal — роллплей ИИ на русском
      </p>
    </footer>
  );
}
