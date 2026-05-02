import { perfRecorder } from "./recorder";

/**
 * Monkey-patch fetch + WebSocket so every network call is timed without
 * touching business code. Only loaded in perf builds.
 */
export function installAutoInstrument(): () => void {
  const restoreFetch = patchFetch();
  const restoreWs = patchWebSocket();
  return () => {
    restoreFetch();
    restoreWs();
  };
}

function isPerfSelfCall(url: string): boolean {
  // Perf panel polls these endpoints itself — recording them would just
  // create noise in the timeline and inflate the network tab.
  return url.includes("/api/v1/perf/");
}

function patchFetch(): () => void {
  const original = window.fetch;
  if (!original) return () => {};
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const start = performance.now();
    const input = args[0];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input);
    const skip = isPerfSelfCall(url);
    let status = 0;
    let ok = false;
    try {
      const res = await original.apply(window, args);
      status = res.status;
      ok = res.ok;
      return res;
    } finally {
      if (!skip) {
        perfRecorder.record({
          ts: start,
          kind: "fetch",
          name: shortenUrl(url),
          duration: performance.now() - start,
          meta: { url, status, ok },
        });
      }
    }
  };
  return () => {
    window.fetch = original;
  };
}

function patchWebSocket(): () => void {
  const Original = window.WebSocket;
  if (!Original) return () => {};

  class InstrumentedWebSocket extends Original {
    private _openTs = performance.now();
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const u = url.toString();
      const opened = this._openTs;
      this.addEventListener("open", () => {
        perfRecorder.record({
          ts: opened,
          kind: "ws",
          name: `open ${shortenUrl(u)}`,
          duration: performance.now() - opened,
          meta: { url: u, phase: "open" },
        });
      });
      this.addEventListener("close", (e) => {
        perfRecorder.record({
          ts: performance.now(),
          kind: "ws",
          name: `close ${shortenUrl(u)}`,
          duration: 0,
          meta: { url: u, phase: "close", code: e.code, reason: e.reason },
        });
      });
      this.addEventListener("error", () => {
        perfRecorder.record({
          ts: performance.now(),
          kind: "ws",
          name: `error ${shortenUrl(u)}`,
          duration: 0,
          meta: { url: u, phase: "error" },
        });
      });
      // Per-message processing time is dominated by app handlers (which run
      // synchronously off `onmessage`). Wrap addEventListener for "message"
      // so each handler invocation is timed.
      const origAdd = this.addEventListener.bind(this);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type !== "message" || typeof listener !== "function") {
          return origAdd(type, listener, options);
        }
        const wrapped: EventListener = (ev) => {
          const t0 = performance.now();
          try {
            (listener as EventListener)(ev);
          } finally {
            const dt = performance.now() - t0;
            if (dt >= 4) {
              perfRecorder.record({
                ts: t0,
                kind: "ws",
                name: `message ${shortenUrl(u)}`,
                duration: dt,
                meta: { url: u, phase: "message" },
              });
            }
          }
        };
        return origAdd(type, wrapped, options);
      };
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).WebSocket = InstrumentedWebSocket;
  return () => {
    window.WebSocket = Original;
  };
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + (u.search ? u.search.slice(0, 40) : "");
  } catch {
    return url.slice(0, 80);
  }
}
