import { promptRolloutFinalized } from "@/lib/promptRolloutPolicy";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { isPromptV2Enabled } from "@/lib/promptState";

export const runtime = "nodejs";
export async function GET() {
  let finalized = false;
  if (isPromptV2Enabled()) {
    try { finalized = await promptRolloutFinalized(); }
    catch (error) { errorLog("PromptRollout", "status unavailable", toSafeDiagnostic(error)); }
  }
  return Response.json({ rolloutEnabled: isPromptV2Enabled(), finalized }, { headers: { "Cache-Control": "private, no-store" } });
}
