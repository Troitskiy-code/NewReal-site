import { notFound } from "next/navigation";
import CharacterCreateEditor from "@/components/CharacterCreateEditor";
import { ROLEPLAY_MODES, type RoleplayMode } from "@/lib/roleplayConfig";

export default async function CreateModePage({ params }: { params: Promise<{ mode: string }> }) {
  const { mode } = await params;
  if (!ROLEPLAY_MODES.includes(mode as RoleplayMode)) notFound();
  return <CharacterCreateEditor key={mode} initialMode={mode as RoleplayMode} />;
}
