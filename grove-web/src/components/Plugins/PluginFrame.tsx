import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { apiClient, appendHmacToUrl } from "../../api/client";
import { useProject, useTheme } from "../../context";
import type { Plugin } from "../../api/plugins";
import { listPluginChats, sendPluginChat } from "../../api/plugins";
import {
  resolvePluginEntry,
  type PluginUiContribution,
  type PluginUiManifest,
} from "./pluginEntry";
import { ensurePluginAssetSession, getPluginAssetSessionGeneration, subscribeToPluginAssetSessionChanges } from "./pluginAssetSession";
import { buildPluginThemePayload, readOrbitTokens } from "./pluginTheme";
import { dispatchPluginNavigation, isPluginFrameShown, resolvePluginNavigation } from "./pluginNavigation";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { PanelError } from "../../orbit/ui/PanelShell";
import { useInPanelShell, usePanelMenuItems, type PanelMenuItem } from "../../orbit/ui/panelSlots";
import "./orbit-plugins.css";

/** Encode each path segment but keep `/` separators (for the /data/{*path} route). */
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/**
 * Renders a plugin's UI in a **fully isolated** sandboxed iframe and hosts the
 * plugin↔Grove postMessage bridge.
 *
 * Isolation (the "A" model): the iframe is `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so its origin is opaque — it cannot `fetch()` Grove's
 * API directly, and the bridge below is its *only* channel to the host. That
 * makes the plugin's declared `storage` / `project` permissions a real boundary
 * (enforced here + in the backend), not advisory. Because the origin is opaque,
 * the bridge authenticates the peer by **window identity** (`event.source`),
 * not by origin string, and posts back with targetOrigin `"*"` (safe: we always
 * post to the specific iframe we hold a ref to).
 *
 * Bridge methods (all gated by the backend against the plugin's manifest perms):
 *   - `host.getInfo` → current project (+ `projectType`), `taskId` and `interface`.
 *   - `host.navigate` → open this plugin's own page or a Settings section
 *                       (`pluginNavigation.ts`); never another plugin or a URL.
 *   - `theme.get`     → the theme palette, the interface ("orbit" | "workbench")
 *                       and the resolved Orbit `--o-*` tokens (pushed live on
 *                       theme or interface change). See `pluginTheme.ts`.
 *   - `storage.*`     → the plugin's private storage, scoped global/project/task.
 *   - `project.*`     → read the current task's working dir (task panels only).
 *   - `backend.invoke`→ call the plugin's node backend (contributes.backend).
 *   - `exec.run`      → stream a command's output (high-risk `exec` permission).
 *   - `chat.list`     → list the task's chat sessions (`chat:read`).
 *   - `chat.send`     → inject a user prompt into a chat (`chat:write`).
 *
 * The host also pushes two unsolicited messages into the iframe: `grove:theme`
 * (same payload as `theme.get`) on theme or interface change, and `chat.active` ({ chatId }) on mount + whenever the
 * focused chat changes. Backend ACP events arrive as `grove:event` named
 * `grove:acp` via the events SSE relay (see below).
 */
export function PluginFrame({
  plugin,
  contribution,
  projectId = null,
  taskId = null,
  showReload = true,
}: {
  plugin: Plugin;
  /** Manifest contribution whose UI entry this frame is hosting. */
  contribution: PluginUiContribution;
  /** Project the frame is scoped to. Defaults to the globally-selected project. */
  projectId?: string | null;
  /** Task the frame is scoped to (workspace panel); null for sidebar surfaces. */
  taskId?: string | null;
  showReload?: boolean;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [entry, setEntry] = useState<string | null>(null);
  const generation = useSyncExternalStore(subscribeToPluginAssetSessionChanges, getPluginAssetSessionGeneration);
  const [assetSession, setAssetSession] = useState<{ pluginId: string; token: string | null; generation: number; reloadKey: number } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { selectedProject, projects } = useProject();
  const { theme } = useTheme();
  const orbit = useOrbitInterface();
  const inPanelShell = useInPanelShell();

  // Resolve the scoped project: explicit projectId (task panel) wins over the
  // sidebar selection — Blitz can open a task from a different project.
  const project = projectId ? (projects.find((p) => p.id === projectId) ?? selectedProject) : selectedProject;

  // Read the entry for the surface hosting this frame. A plugin may declare
  // distinct panel and sidebar bundles, so this cannot be inferred globally.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      ensurePluginAssetSession(plugin.id),
      apiClient
        .get<PluginUiManifest>(`/api/v1/plugins/${plugin.id}/asset/plugin.json`)
        .catch(() => null),
    ])
      .then(([token, manifest]) => {
        if (cancelled) return;
        setEntry(manifest ? resolvePluginEntry(manifest, contribution) : "index.html");
        setAssetSession({ pluginId: plugin.id, token, generation, reloadKey });
      })
      .catch(() => {
        if (!cancelled) setAssetSession({ pluginId: plugin.id, token: null, generation, reloadKey });
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, contribution, generation, reloadKey]);

  // postMessage bridge.
  useEffect(() => {
    // Append the current storage scope + ids to a query string. The plugin
    // names the scope; the host supplies the ids (the panel's own project/task)
    // so a plugin can never read another task's scope.
    const scopeQuery = (params: Record<string, unknown>): URLSearchParams => {
      const q = new URLSearchParams();
      q.set("scope", String(params.scope ?? "global"));
      if (project?.id) q.set("projectId", project.id);
      if (taskId) q.set("taskId", taskId);
      return q;
    };

    const handler = (event: MessageEvent) => {
      // Opaque-origin iframe: authenticate by window identity, not origin.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (data?.type !== "plugin-api:request" || !data.id || !data.method) return;
      const reqId = data.id;
      const method = data.method;
      const params = data.params ?? {};

      const post = (payload: Record<string, unknown>) =>
        iframeRef.current?.contentWindow?.postMessage(payload, "*");
      const reply = (payload: { data?: unknown; error?: { code: string; message: string } }) =>
        post({ type: "plugin-api:response", id: reqId, ...payload });

      void (async () => {
        try {
          const base = `/api/v1/plugins/${plugin.id}/data`;
          if (method === "host.getInfo") {
            // No raw host path — the plugin reads files only through the VFS.
            reply({
              data: {
                projectId: project?.id ?? null,
                projectName: project?.name ?? null,
                projectType: project?.projectType ?? null,
                taskId: taskId ?? null,
                interface: orbit ? "orbit" : "workbench",
              },
            });
          } else if (method === "host.navigate") {
            // The plugin id comes from this frame, never from params, so a
            // plugin can only open its own page. Off-screen frames can't move
            // the user away from what they're looking at.
            if (!isPluginFrameShown(iframeRef.current)) {
              reply({ error: { code: "forbidden", message: "host.navigate requires a visible plugin frame" } });
              return;
            }
            const resolved = resolvePluginNavigation(plugin, params);
            const outcome = resolved.ok ? dispatchPluginNavigation(resolved.target) : resolved;
            reply(outcome.ok ? { data: { ok: true } } : { error: outcome.error });
          } else if (method === "theme.get") {
            reply({ data: buildPluginThemePayload(theme, orbit, readOrbitTokens()) });
          } else if (method === "storage.readFile") {
            const path = encodePath(String(params.path ?? ""));
            const r = await apiClient.get<{ content: string | null }>(`${base}/${path}?${scopeQuery(params)}`);
            reply({ data: r.content ?? null });
          } else if (method === "storage.writeFile") {
            const path = encodePath(String(params.path ?? ""));
            await apiClient.put<{ content: string }, { ok: boolean }>(`${base}/${path}?${scopeQuery(params)}`, {
              content: String(params.content ?? ""),
            });
            reply({ data: true });
          } else if (method === "storage.deleteFile") {
            const path = encodePath(String(params.path ?? ""));
            await apiClient.delete(`${base}/${path}?${scopeQuery(params)}`);
            reply({ data: true });
          } else if (method === "storage.list") {
            const q = scopeQuery(params);
            q.set("path", String(params.path ?? ""));
            const r = await apiClient.get<{ entries: { name: string; isDir: boolean }[] }>(
              `/api/v1/plugins/${plugin.id}/data-dir?${q}`,
            );
            reply({ data: r.entries });
          } else if (method === "storage.readBytes") {
            const path = encodePath(String(params.path ?? ""));
            const r = await apiClient.get<{ content: string | null }>(
              `/api/v1/plugins/${plugin.id}/data-bytes/${path}?${scopeQuery(params)}`,
            );
            reply({ data: r.content ?? null });
          } else if (method === "storage.writeBytes") {
            const path = encodePath(String(params.path ?? ""));
            await apiClient.put<{ content: string }, { ok: boolean }>(
              `/api/v1/plugins/${plugin.id}/data-bytes/${path}?${scopeQuery(params)}`,
              { content: String(params.content ?? "") },
            );
            reply({ data: true });
          } else if (method === "project.readFile") {
            if (!taskId || !project?.id) {
              reply({ error: { code: "bad_request", message: "project.readFile requires a task-scoped panel" } });
              return;
            }
            const qs = `projectId=${encodeURIComponent(project.id)}&taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(String(params.path ?? ""))}`;
            const r = await apiClient.get<{ content: string | null }>(
              `/api/v1/plugins/${plugin.id}/project-file?${qs}`,
            );
            reply({ data: r.content ?? null });
          } else if (method === "project.list") {
            if (!taskId || !project?.id) {
              reply({ error: { code: "bad_request", message: "project.list requires a task-scoped panel" } });
              return;
            }
            const qs = `projectId=${encodeURIComponent(project.id)}&taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(String(params.path ?? ""))}`;
            const r = await apiClient.get<{ entries: { name: string; isDir: boolean }[] }>(
              `/api/v1/plugins/${plugin.id}/project-dir?${qs}`,
            );
            reply({ data: r.entries });
          } else if (method === "backend.invoke") {
            // contributes.backend RPC. The host supplies the ids so the backend
            // is launched task-scoped (with that task's project fs access).
            const r = await apiClient.post<
              {
                method: string;
                params: unknown;
                projectId: string | null;
                taskId: string | null;
                timeoutMs?: number;
              },
              { result: unknown }
            >(`/api/v1/plugins/${plugin.id}/backend/invoke`, {
              method: String(params.method ?? ""),
              params: params.params ?? {},
              projectId: project?.id ?? null,
              taskId: taskId ?? null,
              timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
            });
            reply({ data: r.result });
          } else if (method === "chat.list") {
            // List the task's chat sessions. The host supplies the ids (the
            // panel's own project/task); the plugin may not override them with
            // another task's, so optional params.projectId/taskId are ignored.
            const pid = project?.id;
            if (!taskId || !pid) {
              reply({ error: { code: "bad_request", message: "chat.list requires a task-scoped panel" } });
              return;
            }
            const chats = await listPluginChats(plugin.id, pid, taskId);
            reply({ data: chats });
          } else if (method === "chat.send") {
            // Inject a user prompt into one of the task's chats.
            const pid = project?.id;
            if (!taskId || !pid) {
              reply({ error: { code: "bad_request", message: "chat.send requires a task-scoped panel" } });
              return;
            }
            const chatId = String(params.chatId ?? "");
            if (!chatId) {
              reply({ error: { code: "bad_request", message: "chat.send requires a chatId" } });
              return;
            }
            await sendPluginChat(plugin.id, {
              projectId: pid,
              taskId,
              chatId,
              text: String(params.text ?? ""),
            });
            reply({ data: { ok: true } });
          } else if (method === "exec.run") {
            if (!taskId || !project?.id) {
              reply({ error: { code: "bad_request", message: "exec requires a task-scoped panel" } });
              return;
            }
            await streamExec(reqId, params, project.id, taskId, plugin.id, post);
          } else {
            reply({ error: { code: "unknown_method", message: `unknown method: ${method}` } });
          }
        } catch (e) {
          const status = (e as { status?: number })?.status;
          const code =
            status === 404 ? "not_found" :
            status === 403 ? "forbidden" :
            status === 400 ? "bad_request" :
            status && status >= 500 ? "internal" : "error";
          reply({ error: { code, message: e instanceof Error ? e.message : String(e) } });
        }
      })();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [plugin, project, taskId, theme, orbit]);

  // Event bus: subscribe to events the plugin's backend/MCP server push for this
  // task (or the global sidebar scope) and relay them into the isolated iframe.
  // The iframe can't open this stream itself — the host proxies it.
  useEffect(() => {
    const hasServer = plugin.contributes?.mcp || plugin.contributes?.backend;
    if (!hasServer) return;
    let es: EventSource | null = null;
    let cancelled = false;
    void appendHmacToUrl(
      `/api/v1/plugins/${plugin.id}/events/subscribe?taskId=${encodeURIComponent(taskId ?? "global")}`,
    ).then((url) => {
      if (cancelled) return;
      es = new EventSource(url);
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data) as { name?: string; data?: unknown };
          // Relay EVERY event verbatim — no name filtering — so backend-published
          // ACP events (`grove:acp` = { chatId, update }) ride this same path into
          // the iframe with no special-casing, alongside any plugin custom events.
          if (ev && typeof ev.name === "string") {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "grove:event", name: ev.name, data: ev.data },
              "*",
            );
          }
        } catch {
          /* ignore malformed event */
        }
      };
    });
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [plugin.id, taskId, plugin.contributes?.mcp, plugin.contributes?.backend, generation]);

  // Active-chat injection: tell the iframe which chat is currently focused, once
  // on mount and again whenever the focus changes. The real focused-chat id is
  // owned by TaskChat (via useActiveChatId) and broadcast app-wide as the
  // `window.__groveActiveChatId` mirror + a `grove-active-chat-changed`
  // CustomEvent — so we read/subscribe to that here without reaching into
  // TaskChat. Task panels only (sidebar/app surfaces have no focused chat).
  useEffect(() => {
    if (!taskId) return;
    const readActive = (): string | null =>
      (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId ?? null;
    const postActive = (chatId: string | null) =>
      iframeRef.current?.contentWindow?.postMessage({ type: "chat.active", chatId }, "*");

    // Initial push. The iframe's load may race this effect; the SDK also
    // re-requests nothing here, so post both now and on the iframe's load event.
    postActive(readActive());
    const iframe = iframeRef.current;
    const onLoad = () => postActive(readActive());
    iframe?.addEventListener("load", onLoad);

    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail;
      postActive(detail ?? readActive());
    };
    window.addEventListener("grove-active-chat-changed", onChange);
    return () => {
      iframe?.removeEventListener("load", onLoad);
      window.removeEventListener("grove-active-chat-changed", onChange);
    };
  }, [plugin.id, taskId, reloadKey, assetSession?.token]);

  // Push the theme into the iframe whenever it or the interface changes (the
  // SDK requests the initial one via `theme.get` on load; this keeps it live).
  // ThemeProvider writes the new --color-* variables in its own effect, which
  // runs after this one, so the tokens are read a frame later.
  useEffect(() => {
    const push = () =>
      iframeRef.current?.contentWindow?.postMessage({ type: "grove:theme", data: buildPluginThemePayload(theme, orbit, readOrbitTokens()) }, "*");
    if (typeof requestAnimationFrame !== "function") {
      const timer = setTimeout(push, 0);
      return () => clearTimeout(timer);
    }
    const frame = requestAnimationFrame(push);
    return () => cancelAnimationFrame(frame);
  }, [theme, orbit]);

  // Orbit workspace panel: a dev plugin's Reload lives in the panel's ⋯ menu.
  const reloadInMenu = orbit && inPanelShell && showReload && plugin.source === "dev";
  const panelMenu = useMemo<PanelMenuItem[]>(
    () => (reloadInMenu ? [{ id: "reload-plugin", label: "Reload plugin", icon: RefreshCw, onSelect: () => setReloadKey((k) => k + 1) }] : []),
    [reloadInMenu],
  );
  usePanelMenuItems(panelMenu);

  const sessionReady = assetSession?.pluginId === plugin.id && assetSession.generation === generation && assetSession.reloadKey === reloadKey;
  const src =
    entry === null || !sessionReady || !assetSession?.token
      ? undefined
      : `/api/v1/plugin-assets/${assetSession.token}/${plugin.id}/${entry}?v=${reloadKey}`;

  const failed = sessionReady && !assetSession?.token;

  if (orbit) {
    return (
      <div className="oplg-frame-host orbit-ui">
        {showReload && plugin.source === "dev" && !reloadInMenu && (
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload plugin (after rebuild)"
            aria-label="Reload plugin"
            className="oplg-reload"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        )}
        {src ? (
          <iframe
            ref={iframeRef}
            key={reloadKey}
            src={src}
            title={plugin.name}
            // No allow-same-origin → opaque origin → real isolation (see above).
            sandbox="allow-scripts"
            className="oplg-iframe"
          />
        ) : failed ? (
          <PanelError title={`Couldn't open ${plugin.name}`} onRetry={() => setReloadKey((key) => key + 1)}>
            Grove couldn't start a session for this plugin's files.
          </PanelError>
        ) : (
          <div className="oplg-loading" role="status">
            <LoaderCircle className="oui-spin" aria-hidden="true" />
            <span>Loading {plugin.name}…</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="group relative flex h-full w-full flex-col bg-[var(--color-bg)]">
      {/* Reload is a dev affordance (refresh the iframe after `npm run build`).
          Installed plugins never need it; even for dev plugins it stays out of
          the way — bottom corner, revealed only on hover — so it doesn't sit on
          top of the plugin's own toolbar. */}
      {showReload && plugin.source === "dev" && (
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          title="Reload plugin (after rebuild)"
          className="absolute bottom-2 right-2 z-10 rounded-md bg-[var(--color-bg)]/80 p-1.5 text-[var(--color-text-muted)] opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
      {src ? (
        <iframe
          ref={iframeRef}
          key={reloadKey}
          src={src}
          title={plugin.name}
          // No allow-same-origin → opaque origin → real isolation (see above).
          sandbox="allow-scripts"
          className="h-full w-full flex-1 border-0 bg-[var(--color-bg)]"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-[var(--color-text-muted)]">
          {sessionReady && !assetSession.token ? (
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="rounded-lg px-3 py-2 hover:bg-[var(--color-bg-secondary)]">
              Retry
            </button>
          ) : "Loading…"}
        </div>
      )}
    </div>
  );
}

/**
 * Relay a streaming exec: POST to the exec endpoint, parse the NDJSON body, and
 * forward each event to the iframe as `plugin-api:stream`, closing with a final
 * `plugin-api:response`. (The iframe can't open this stream itself — it's
 * isolated — so the host proxies it.)
 */
async function streamExec(
  reqId: string,
  params: Record<string, unknown>,
  projectId: string,
  taskId: string,
  pluginId: string,
  post: (payload: Record<string, unknown>) => void,
) {
  const emit = (event: unknown) => post({ type: "plugin-api:stream", id: reqId, event });
  try {
    const resp = await apiClient.postStream(`/api/v1/plugins/${pluginId}/exec`, {
      command: String(params.command ?? ""),
      args: Array.isArray(params.args) ? params.args : [],
      projectId,
      taskId,
    });
    if (!resp.body) {
      emit({ type: "error", message: "exec stream unavailable" });
      post({ type: "plugin-api:response", id: reqId, data: null });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const lineStr = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (lineStr) {
          try {
            emit(JSON.parse(lineStr));
          } catch {
            /* ignore malformed line */
          }
        }
      }
    }
    post({ type: "plugin-api:response", id: reqId, data: null });
  } catch (e) {
    emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    post({ type: "plugin-api:response", id: reqId, data: null });
  }
}
