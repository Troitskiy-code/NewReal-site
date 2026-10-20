// TEMPORARY (2026-10-20): see src/lib/adminEmbeddingProbe.ts.
import { after } from "next/server";
import { supportAdminAuthorized, supportAdminOriginAllowed } from "@/lib/supportAdmin";
import { embeddingProbeStatus, executeEmbeddingProbe, reserveEmbeddingProbe, EmbeddingProbeBusyError, EmbeddingProbeConfigurationError } from "@/lib/adminEmbeddingProbe";

export const runtime = "nodejs";
export const maxDuration = 900;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  return reply(embeddingProbeStatus());
}
export async function POST(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  if (!supportAdminOriginAllowed(request)) return reply({ error: "Откройте панель на основном адресе сайта" }, 403);
  try {
    const text = await request.text();
    if (text.length > 256) return reply({ error: "Запрос слишком большой" }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true
      || Object.keys(body).some(key => !["rounds", "confirmed"].includes(key))) {
      return reply({ error: "Укажите число раундов и подтвердите замер" }, 400);
    }
    const job = reserveEmbeddingProbe(body.rounds);
    after(() => executeEmbeddingProbe(job));
    return reply(embeddingProbeStatus(), 202);
  } catch (error) {
    if (error instanceof EmbeddingProbeBusyError) return reply({ error: "Замер уже идёт" }, 409);
    if (error instanceof EmbeddingProbeConfigurationError) return reply({ error: "Нужен ключ DeepInfra и число раундов в допустимых пределах" }, 400);
    return reply({ error: "Не удалось запустить замер" }, 400);
  }
}
