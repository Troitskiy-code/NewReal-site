"use client";
import { useEffect, useState } from "react";

export function usePromptRolloutFinalized() {
  const [finalized, setFinalized] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/prompts/rollout", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!controller.signal.aborted) setFinalized(data?.finalized === true); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return finalized;
}
