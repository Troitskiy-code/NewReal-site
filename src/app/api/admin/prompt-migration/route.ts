// Retired mutation address: stale clients cannot change the prompt engine.
const retired = () => Response.json({ error: "Этот адрес больше не используется. Обновите страницу." }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
export const GET = retired;
export const POST = retired;
