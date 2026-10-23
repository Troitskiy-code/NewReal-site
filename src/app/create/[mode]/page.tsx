import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CharacterCreateEditor from "@/components/CharacterCreateEditor";
import { ROLEPLAY_MODES, type RoleplayMode } from "@/lib/roleplayConfig";
import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  return { ...await getLocalizedPageMetadata("create", { inheritOnly: true }), robots: { index: false, follow: true } };
}

export default async function CreateModePage({ params }: { params: Promise<{ mode: string }> }) {
  const { mode } = await params;
  if (!ROLEPLAY_MODES.includes(mode as RoleplayMode)) notFound();
  return <CharacterCreateEditor key={mode} initialMode={mode as RoleplayMode} />;
}
