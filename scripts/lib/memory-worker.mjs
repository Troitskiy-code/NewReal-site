// Persistent jobs survive application restarts. Each process can poll: database
// leases serialize each story. No prompt, key or story identifier is logged.
export function startMemoryWorker({ port = process.env.PORT || '3000', secret = process.env.CRON_SECRET,
  onEvent = () => {}, fetchImpl = fetch, intervalMs = 10_000 } = {}) {
  if (!secret || !/^\d{1,5}$/.test(String(port))) return { stop() {} };
  let stopped = false, timer, controller, lastFailure;
  const tick = async () => {
    if (stopped) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000); timeout.unref?.();
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/cron/memory-jobs`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok && lastFailure !== response.status) onEvent({ event: 'memory_worker_unavailable', status: response.status });
      lastFailure = response.ok ? undefined : response.status;
      await response.body?.cancel();
    } catch {
      if (!stopped && lastFailure !== 'network') onEvent({ event: 'memory_worker_waiting_for_app' });
      lastFailure = 'network';
    } finally {
      clearTimeout(timeout);
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
    }
  };
  timer = setTimeout(tick, intervalMs); timer.unref?.();
  return { stop() { stopped = true; clearTimeout(timer); controller?.abort(); } };
}
