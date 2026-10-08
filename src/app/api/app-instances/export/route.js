import { NextResponse } from "next/server";

// Retired: exporting this server's files and credentials is not a user capability.
export async function POST() {
  return NextResponse.json(
    { error: "Экспорт серверного проекта отключён", code: "SERVER_EXPORT_DISABLED" },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
