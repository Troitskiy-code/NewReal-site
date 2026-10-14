// Runs alongside Next on the existing server. Only the authenticated loopback
// endpoint performs work; leases and paid-request reservations live in PostgreSQL.
export function startCharacterGenerationWorker({ port = process.env.PORT || '3000', secret = process.env.CRON_SECRET,
  onEvent = () => {}, fetchImpl = fetch, intervalMs = 5000 } = {}) {
  if (!secret || !/^\d{1,5}$/.test(String(port))) return { stop() {} };
  let stopped = false, timer, controller, lastFailure = null;
  const url = `http://127.0.0.1:${port}/api/cron/generate-characters`;
  async function tick() {
    if (stopped) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 80_000); timeout.unref?.();
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}` },
        redirect: 'error', signal: controller.signal });
      if (!response.ok && lastFailure !== response.status) { onEvent({ event: 'character_worker_unavailable', status: response.status }); lastFailure = response.status; }
      if (response.ok) lastFailure = null;
      await response.body?.cancel();
    } catch {
      if (!stopped && lastFailure !== 'network') { onEvent({ event: 'character_worker_waiting_for_app' }); lastFailure = 'network'; }
    } finally {
      clearTimeout(timeout);
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
    }
  }
  timer = setTimeout(tick, intervalMs); timer.unref?.();
  return { stop() { stopped = true; clearTimeout(timer); controller?.abort(); } };
}
