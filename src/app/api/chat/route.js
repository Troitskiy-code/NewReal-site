// Retired generic prompt passthrough. Chat requests must use the scoped v2 path.
export async function POST() {
  return Response.json({ error: "Этот адрес больше не используется. Обновите страницу." }, {
    status: 410,
    headers: { "Cache-Control": "private, no-store" },
  });
}
