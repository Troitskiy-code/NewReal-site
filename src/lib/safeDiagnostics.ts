import { errorLog, toSafeDiagnostic } from "./logger";
import type { SafeLogValue } from "./redactSensitive";

export { toSafeDiagnostic };
export type { SafeLogValue };

export function reportAuthFailure(scope: string, error: unknown): void {
  errorLog("Auth", scope, toSafeDiagnostic(error));
}

export async function withAuthErrorReport<T>(scope: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    reportAuthFailure(scope, error);
    throw error;
  }
}

export function reportPrismaFailure(scope: string, error: unknown): void {
  errorLog("Prisma", scope, toSafeDiagnostic(error));
}

export function reportPaymentFailure(scope: string, error: unknown): void {
  errorLog("Payment", scope, toSafeDiagnostic(error));
}
