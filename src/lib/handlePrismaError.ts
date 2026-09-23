import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function prismaErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

export function isPrismaPoolExhausted(error: unknown): boolean {
  const code = prismaErrorCode(error);
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2024" || error.code === "P2023")
  ) {
    return true;
  }
  if (code === "P2024" || code === "P2023") {
    return true;
  }

  const message = errorMessage(error);
  return (
    /too many database connections/i.test(message) ||
    /remaining connection slots/i.test(message) ||
    /timed out fetching a new connection/i.test(message)
  );
}

export function prismaPoolOverloadResponse(error: unknown): NextResponse | null {
  if (!isPrismaPoolExhausted(error)) return null;

  console.error("[pool] connection pool timeout:", errorMessage(error));
  return new NextResponse("Сервис временно перегружен", {
    status: 503,
    headers: {
      "Retry-After": "5",
      "Cache-Control": "no-store",
    },
  });
}
