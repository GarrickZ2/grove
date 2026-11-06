import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, Square } from "lucide-react";
import { controlPluginRuntime, getPluginRuntime, type PluginRuntime as Runtime } from "../../api/plugins";
import { Button } from "../ui";

const POLL_MS = 3000;

const STATE_LABEL: Record<Runtime["state"], string> = {
  stopped: "Stopped",
  running: "Running",
  restarting: "Restarting",
  failed: "Failed",
  elsewhere: "Running in another window",
};

const STATE_COLOR: Record<Runtime["state"], string> = {
  stopped: "var(--color-text-muted)",
  running: "var(--color-success)",
  restarting: "var(--color-warning)",
  failed: "var(--color-error)",
  elsewhere: "var(--color-info)",
};

/** Live state, controls and recent logs of a plugin's background process. */
export function PluginRuntimeSection({ pluginId, service }: { pluginId: string; service: boolean }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuntime(await getPluginRuntime(pluginId));
    } catch {
      // Keep the last state; the next poll retries.
    }
  }, [pluginId]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [refresh]);

  const control = async (action: "start" | "stop" | "restart") => {
    setBusy(true);
    setError(null);
    try {
      setRuntime(await controlPluginRuntime(pluginId, action));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!runtime) return null;
  const running = runtime.state === "running";
  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">Background process</h3>
        <div className="flex items-center gap-2">
          {running ? (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void control("restart")}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Restart</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void control("stop")}><Square className="mr-1.5 h-3.5 w-3.5" />Stop</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy || runtime.state === "elsewhere"} onClick={() => void control("start")}><Play className="mr-1.5 h-3.5 w-3.5" />Start</Button>
          )}
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-[var(--color-border)] px-3.5 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-2 font-medium text-[var(--color-text)]">
            <span className="h-2 w-2 rounded-full" style={{ background: STATE_COLOR[runtime.state] }} />
            {STATE_LABEL[runtime.state]}
          </span>
          {service && <span className="text-xs text-[var(--color-text-muted)]">Stays running while Grove is open</span>}
          {runtime.pid !== null && <span className="text-xs text-[var(--color-text-muted)]">PID {runtime.pid}</span>}
          {runtime.restarts > 0 && <span className="text-xs text-[var(--color-text-muted)]">{runtime.restarts} restart{runtime.restarts === 1 ? "" : "s"}</span>}
        </div>
        {runtime.detail && <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">{runtime.detail}</p>}
        {runtime.lastError && <p className="mt-1.5 text-xs text-[var(--color-error)]">{runtime.lastError}</p>}
        {error && <p role="alert" className="mt-1.5 text-xs text-[var(--color-error)]">{error}</p>}
      </div>
      {runtime.logs.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-[var(--color-bg-secondary)] p-3 font-mono text-[11px] leading-4 text-[var(--color-text-secondary)]">
          {runtime.logs.slice(-100).join("\n")}
        </pre>
      )}
    </section>
  );
}
