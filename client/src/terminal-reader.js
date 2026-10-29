// Status checks are read-only. Never retry payment creation or reader actions here.
export function createTerminalReaderMonitor({
  request,
  onReader,
  onError,
  onChecking,
  intervalMs = 15000,
  timeoutMs = 12000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = false;
  let pending = null;
  let pollTimer;

  function refresh() {
    if (stopped) return Promise.resolve(null);
    if (pending) return pending.promise;
    cancel(pollTimer);
    const controller = new AbortController();
    const current = { controller };
    pending = current;
    onChecking(true);
    current.promise = (async () => {
      let timeout;
      try {
        const result = await Promise.race([
          request("/stripe/terminal/status", { signal: controller.signal, cache: "no-store" }),
          new Promise((_, reject) => {
            current.cancel = () => reject(new Error("Reader check canceled."));
            timeout = schedule(() => {
              reject(new Error("Reader status check timed out. Check your connection and try again."));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
        if (stopped) return null;
        if (!result?.reader?.id || !["online", "offline"].includes(result.reader.status)) {
          throw new Error("The server did not return a reader status. Try again or check the server's Stripe Terminal configuration.");
        }
        onReader(result.reader);
        onError("");
        return result.reader;
      } catch (error) {
        if (!stopped) {
          onReader(null);
          onError(error.message || "Unable to check the reader connection.");
        }
        return null;
      } finally {
        cancel(timeout);
        if (!stopped) {
          pending = null;
          onChecking(false);
          pollTimer = schedule(refresh, intervalMs);
        }
      }
    })();
    return current.promise;
  }

  return {
    refresh,
    stop() {
      stopped = true;
      cancel(pollTimer);
      pending?.controller.abort();
      pending?.cancel?.();
    },
  };
}
