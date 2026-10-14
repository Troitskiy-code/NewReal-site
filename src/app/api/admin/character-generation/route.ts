import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { createGenerationBatch, controlGenerationBatch, generationStatus, secretMatches } from "@/lib/characterGeneration";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function owner(req: NextRequest) {
  if (!secretMatches(process.env.ADMIN_SECRET, req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null)) return null;
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}
function failure(error: unknown) {
  if (error instanceof ClientInputError) return json({ error: error.message }, 400);
  if (["P2021", "P2022"].includes((error as { code?: string }).code))
    return json({ error: "Для генератора необходимо применить миграцию базы данных.", migrationRequired: true }, 503);
  errorLog("CharacterGeneration", "Admin request failed", toSafeDiagnostic(error));
  return json({ error: "Не удалось обновить партию. Повторите запрос." }, 500);
}
export async function GET(req: NextRequest) {
  try {
    const userId = await owner(req);
    if (!userId) return json({ error: "Войдите в аккаунт и укажите ключ администратора" }, 401);
    return json(await generationStatus(userId));
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    const userId = await owner(req);
    if (!userId) return json({ error: "Недостаточно прав" }, 401);
    const raw = await req.text();
    if (raw.length > 4096) return json({ error: "Запрос слишком большой" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Некорректный запрос" }, 400); }
    if (body?.action === "start") await createGenerationBatch(userId, String(body.clientKey ?? ""), Number(body.count), Number(body.budgetRub));
    else await controlGenerationBatch(userId, String(body?.batchId ?? ""), String(body?.action ?? ""),
      typeof body?.itemId === "string" ? body.itemId : undefined, typeof body?.taskId === "string" ? body.taskId : undefined);
    return json(await generationStatus(userId));
  } catch (error) { return failure(error); }
}
