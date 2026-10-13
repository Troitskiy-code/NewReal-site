// Server-rendered chat shell for the local browser test. No database connection.
const target = new URL(process.env.DATABASE_URL);
if (target.hostname !== '127.0.0.1' || target.port !== '1' || target.pathname !== '/synthetic') {
  throw new Error('Editor fixture requires the synthetic, unreachable database URL');
}
const card = { id: 'synthetic-card', name: 'Экспедиция', name_en: 'Expedition', updatedAt: new Date('2026-10-12T00:00:00Z') };
const fixture = {
  character: { findUnique: async ({ where }) => where.id === card.id ? { ...card } : null },
  $extends() { return this; },
};
globalThis.prismaBase = fixture;
globalThis.prisma = fixture;
