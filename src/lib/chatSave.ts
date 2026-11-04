import { errorLog, toSafeDiagnostic } from "./logger";

// A reply is saved after the user has read it, so a save that times out loses it. With Prisma's default 5 s,
// 42 replies a week failed with P2028 (prod logs 2026-10-28 – 11-03) while waiting for the story lock or the
// database. A timed-out interactive transaction is rolled back, so one retry cannot store a message twice.
export const SAVE_TRANSACTION = { maxWait: 5_000, timeout: 15_000 };
export const SLOW_SAVE_MS = 2_000;

export async function retrySaveOnTimeout<T>(role: string, save: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await save(attempt);
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string })?.code !== "P2028") throw error;
      errorLog("ChatSave", "save retried", { messageRole: role, attempt }, toSafeDiagnostic(error));
    }
  }
}
