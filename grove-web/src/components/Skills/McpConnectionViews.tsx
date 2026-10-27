import {
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../ui";
import { openExternalUrl } from "../../utils/openExternal";
import type {
  McpAuthOptions,
  McpConnectionController,
} from "./useMcpConnection";
import {
  connectionPresentation,
  requiresMcpAuthorization,
} from "./mcpManagementState";

export const mcpInputClass =
  "mt-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 py-2.5 text-sm text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)] disabled:opacity-60";
export const mcpIconButtonClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]";

export function McpFeedback({
  error,
  notice,
}: {
  error?: string | null;
  notice?: string | null;
}) {
  if (!error && !notice) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded-lg border px-3.5 py-3 text-xs leading-5 ${error ? "border-[var(--color-error)]/25 bg-[var(--color-error)]/5 text-[var(--color-error)]" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 text-[var(--color-text-muted)]"}`}
    >
      {error || notice}
    </div>
  );
}

export function McpDisclosure({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-3 space-y-4">{children}</div>
    </details>
  );
}

export function McpAuthFields({
  options,
  onChange,
}: {
  options: McpAuthOptions;
  onChange: (value: McpAuthOptions) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-[var(--color-text-muted)]">
        Most servers configure this automatically. Enter these values only if
        your provider supplies them.
      </p>
      <label className="block text-xs font-medium text-[var(--color-text)]">
        Client ID
        <input
          className={mcpInputClass}
          value={options.clientId ?? ""}
          onChange={(event) =>
            onChange({ ...options, clientId: event.target.value })
          }
          autoComplete="off"
        />
      </label>
      <label className="block text-xs font-medium text-[var(--color-text)]">
        Client secret{" "}
        <span className="font-normal text-[var(--color-text-muted)]">
          (optional)
        </span>
        <input
          className={mcpInputClass}
          type="password"
          value={options.clientSecret ?? ""}
          onChange={(event) =>
            onChange({ ...options, clientSecret: event.target.value })
          }
          autoComplete="new-password"
        />
      </label>
      <label className="block text-xs font-medium text-[var(--color-text)]">
        Registered callback URL{" "}
        <span className="font-normal text-[var(--color-text-muted)]">
          (optional)
        </span>
        <input
          className={mcpInputClass}
          value={options.callbackUrl ?? ""}
          onChange={(event) =>
            onChange({ ...options, callbackUrl: event.target.value })
          }
          placeholder="http://127.0.0.1:3005/callback"
          autoComplete="off"
        />
      </label>
    </div>
  );
}

export function McpSignInWaiting({
  controller,
}: {
  controller: McpConnectionController;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--color-highlight)]" />
        <div>
          <p className="text-sm font-medium text-[var(--color-text)]">
            {controller.phase === "checking"
              ? "Finishing connection…"
              : "Complete sign-in in your browser"}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            This page will update when authorization is complete.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={controller.busy}
          onClick={() =>
            controller.flow?.authorization_url &&
            openExternalUrl(controller.flow.authorization_url)
          }
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          Open sign-in page
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={controller.busy}
          onClick={() => void controller.cancelSignIn()}
        >
          Cancel sign-in
        </Button>
      </div>
      <McpDisclosure title="Complete sign-in from another device">
        <p className="text-xs leading-5 text-[var(--color-text-muted)]">
          If the final page cannot open, paste its full address from the
          browser.
        </p>
        <label className="block text-xs font-medium text-[var(--color-text)]">
          Callback URL
          <input
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            className={mcpInputClass}
            placeholder="http://127.0.0.1:…/callback?code=…"
            autoComplete="off"
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={controller.busy || !callbackUrl.trim()}
          onClick={() => void controller.completeSignIn(callbackUrl)}
        >
          Complete sign-in
        </Button>
      </McpDisclosure>
    </div>
  );
}

export function McpConnectionStatus({
  controller,
  children,
}: {
  controller: McpConnectionController;
  children?: ReactNode;
}) {
  const presentation = connectionPresentation(controller.connection);
  const loading =
    controller.phase === "loading" || controller.phase === "checking";
  const color =
    presentation.tone === "success"
      ? "text-[var(--color-success)]"
      : presentation.tone === "danger"
        ? "text-[var(--color-error)]"
        : presentation.tone === "warning"
          ? "text-[var(--color-warning)]"
          : "text-[var(--color-text-muted)]";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg)] ${loading ? "text-[var(--color-text-muted)]" : color}`}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-text)]">
            {loading ? "Checking connection…" : presentation.label}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-muted)]">
            {loading
              ? "Reading the server’s connection details."
              : presentation.detail}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

export function McpConnectionSection({
  controller,
  url,
  onDisconnect,
}: {
  controller: McpConnectionController;
  url: string;
  onDisconnect: () => void;
}) {
  const [options, setOptions] = useState<McpAuthOptions>({});
  const c = controller.connection;
  const oauth = c?.auth_type === "oauth";
  const needsAuthorization = requiresMcpAuthorization(c);
  return (
    <section className="space-y-3" aria-labelledby="mcp-connection-title">
      <div className="flex items-center justify-between gap-3">
        <h3
          id="mcp-connection-title"
          className="text-sm font-semibold text-[var(--color-text)]"
        >
          Connection
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={controller.busy || controller.waiting}
          onClick={() => void controller.check()}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${controller.phase === "checking" ? "animate-spin" : ""}`}
          />
          Check connection
        </Button>
      </div>
      <p className="break-all font-mono text-xs leading-5 text-[var(--color-text-muted)]">
        {url}
      </p>
      {controller.waiting ? (
        <McpSignInWaiting controller={controller} />
      ) : (
        <>
          <McpConnectionStatus controller={controller}>
            {needsAuthorization && (
              <Button
                size="sm"
                disabled={controller.busy}
                onClick={() => void controller.authorize(options)}
              >
                Authorize
              </Button>
            )}
          </McpConnectionStatus>
          {oauth && c?.has_credentials && (
            <div className="flex flex-wrap items-center gap-1">
              {!needsAuthorization && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={controller.busy}
                  onClick={() => void controller.authorize(options)}
                >
                  Reauthorize
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={controller.busy}
                onClick={onDisconnect}
              >
                <Unplug className="mr-1.5 h-3.5 w-3.5" />
                Cancel authorization
              </Button>
            </div>
          )}
        </>
      )}
      <McpFeedback
        error={controller.error || c?.error}
        notice={controller.notice}
      />
      {!controller.waiting && (
        <McpDisclosure
          title={oauth ? "Authorization details" : "Connection details"}
        >
          <dl className="space-y-2 text-xs">
            {c?.checked_at && (
              <div className="flex flex-wrap justify-between gap-1">
                <dt className="text-[var(--color-text-muted)]">Last checked</dt>
                <dd>{formatTime(c.checked_at)}</dd>
              </div>
            )}
            {c?.expires_at && (
              <div className="flex flex-wrap justify-between gap-1">
                <dt className="text-[var(--color-text-muted)]">
                  Token expires
                </dt>
                <dd>{formatTime(c.expires_at)}</dd>
              </div>
            )}
            {!!c?.scopes.length && (
              <div>
                <dt className="mb-1.5 text-[var(--color-text-muted)]">
                  Granted scopes
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {c.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="rounded-md border border-[var(--color-border)] px-2 py-1 font-mono"
                    >
                      {scope}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          {oauth && <McpAuthFields options={options} onChange={setOptions} />}
        </McpDisclosure>
      )}
    </section>
  );
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1000));
}
