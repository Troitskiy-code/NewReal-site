import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import TelegramEntry from "./TelegramEntry";

// Mini App URL (set in @BotFather): https://<site>/tg. Signs in with the verified launch data
// and opens the catalog or the character from startapp. Not indexed (layout metadata + proxy header).

export async function generateMetadata() {
  const locale = await getRequestLocale();
  return { title: `NewVerse — ${translate(locale, "telegram.entryTitle")}` };
}

export default function TelegramEntryPage() {
  return <TelegramEntry />;
}
