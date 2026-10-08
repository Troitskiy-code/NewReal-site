import { NextResponse } from "next/server";

// Downloads happen in the browser. This server never fetches a caller-supplied URL.
export async function GET() {
  return NextResponse.json(
    { error: "Скачивание через сервер отключено", code: "DOWNLOAD_PROXY_DISABLED" },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
