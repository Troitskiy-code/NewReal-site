import { after } from "next/server";
import { supportAdminAuthorized, supportAdminOriginAllowed } from "@/lib/supportAdmin";
import { adminDiagnosticPlan, adminDiagnosticStatus, reserveAdminDiagnostic, executeAdminDiagnostic, DiagnosticBusyError, DiagnosticConfigurationError } from "@/lib/adminChatDiagnostic";

export const runtime = "nodejs";
export const maxDuration = 300;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  try { const status = adminDiagnosticStatus(); return reply({ ...status, plan: status.job ? adminDiagnosticPlan(status.job.model) : null }); }
  catch { return reply({ error: "Проверьте настройки провайдера" }, 503); }
}
export async function POST(request: Request) {
  if (!supportAdminAuthorized(request)) return reply({ error: "Нет доступа" }, 401);
  if (!supportAdminOriginAllowed(request)) return reply({ error: "Откройте панель на основном адресе сайта" }, 403);
  try {
    const text = await request.text();
    if (text.length > 1024) return reply({ error: "Запрос слишком большой" }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(key => !["model", "confirmed"].includes(key))) {
      return reply({ error: "Выберите модель и подтвердите тест" }, 400);
    }
    const job = reserveAdminDiagnostic(body.model);
    after(() => executeAdminDiagnostic(job));
    return reply({ ...adminDiagnosticStatus(), plan: adminDiagnosticPlan(job.model) }, 202);
  } catch (error) {
    if (error instanceof DiagnosticBusyError) return reply({ error: "Тест уже идёт или не закончилась минутная пауза" }, 409);
    if (error instanceof DiagnosticConfigurationError) return reply({ error: "Нужны DeepInfra и одна из доступных моделей теста" }, 400);
    return reply({ error: "Не удалось запустить тест" }, 400);
  }
}
