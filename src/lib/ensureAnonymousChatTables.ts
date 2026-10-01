export async function ensureAnonymousChatTables(): Promise<void> {
  const { assertGuestSchemaReady } = await import("@/lib/guestRequestStore");
  await assertGuestSchemaReady();
}
