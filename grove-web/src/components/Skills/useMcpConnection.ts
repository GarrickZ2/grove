import { useCallback, useEffect, useRef, useState } from "react";
import {
  authorizeMcp,
  cancelMcpAuth,
  disconnectMcp,
  finishMcpAuth,
  getMcpAuthFlow,
  getMcpConnection,
  probeMcp,
  type McpAuthFlow,
  type McpConnection,
} from "../../api/extensions";
import { openExternalUrl } from "../../utils/openExternal";

export type McpConnectionPhase =
  | "loading"
  | "checking"
  | "authorizing"
  | "cancelling"
  | "disconnecting"
  | "finishing"
  | null;
export interface McpAuthOptions {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
}
const EMPTY_HEADERS: Record<string, string> = {};

export function mcpErrorText(cause: unknown): string {
  if (
    cause &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  return "The operation could not be completed. Try again.";
}

/** Owns one URL's connection lifecycle. A completed OAuth flow is published
 * only after its credential snapshot and server metadata have been loaded. */
export function useMcpConnection({
  url,
  headers = EMPTY_HEADERS,
  autoCheck = false,
  onChange,
}: {
  url: string;
  headers?: Record<string, string>;
  autoCheck?: boolean;
  onChange?: (connection: McpConnection) => void;
}) {
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [phase, setPhase] = useState<McpConnectionPhase>("loading");
  const [flow, setFlow] = useState<McpAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const activeFlow = useRef<string | null>(null);
  const nextRequest = useCallback(() => ++revision.current, []);
  const latest = useRef({ headers, onChange });
  useEffect(() => {
    latest.current = { headers, onChange };
  }, [headers, onChange]);

  const publish = useCallback((value: McpConnection) => {
    setConnection(value);
    latest.current.onChange?.(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const request = nextRequest();
    const current = () => mounted.current && revision.current === request;
    void (
      autoCheck ? probeMcp(url, latest.current.headers) : getMcpConnection(url)
    )
      .then((value) => {
        if (current()) publish(value);
      })
      .catch((cause) => {
        if (current()) setError(mcpErrorText(cause));
      })
      .finally(() => {
        if (current()) setPhase(null);
      });
    return () => {
      mounted.current = false;
      nextRequest();
      const id = activeFlow.current;
      activeFlow.current = null;
      if (id) void cancelMcpAuth(id).catch(() => {});
    };
  }, [url, autoCheck, publish, nextRequest]);

  const run = useCallback(
    async (
      nextPhase: McpConnectionPhase,
      operation: (current: () => boolean) => Promise<void>,
    ) => {
      const request = nextRequest();
      const current = () => mounted.current && revision.current === request;
      setPhase(nextPhase);
      setError(null);
      setNotice(null);
      try {
        await operation(current);
      } catch (cause) {
        if (current()) setError(mcpErrorText(cause));
      } finally {
        if (current()) setPhase(null);
      }
    },
    [nextRequest],
  );

  const check = useCallback(
    () =>
      run("checking", async (current) => {
        const value = await probeMcp(url, latest.current.headers);
        if (current()) publish(value);
      }),
    [url, run, publish],
  );

  const authorize = useCallback(
    (options: McpAuthOptions = {}) =>
      run("authorizing", async (current) => {
        const value = await authorizeMcp(
          url,
          options.clientId,
          options.clientSecret,
          options.callbackUrl,
        );
        // Closing the page while registration is pending must not leave a login
        // flow running with no owner.
        if (!current()) {
          void cancelMcpAuth(value.id).catch(() => {});
          return;
        }
        activeFlow.current = value.id;
        setFlow(value);
        if (value.authorization_url) openExternalUrl(value.authorization_url);
      }),
    [url, run],
  );

  const cancelSignIn = useCallback(
    () =>
      run("cancelling", async (current) => {
        const id = activeFlow.current;
        if (!id) return;
        await cancelMcpAuth(id);
        if (current()) {
          activeFlow.current = null;
          setFlow(null);
          // The browser callback may have won the race with cancellation.
          // Read the saved grant rather than assuming it was never issued.
          const saved = await getMcpConnection(url);
          if (current()) publish(saved);
        }
      }),
    [run, url, publish],
  );

  const completeSignIn = useCallback(
    (callbackUrl: string) =>
      run("finishing", async () => {
        const id = activeFlow.current;
        if (id) await finishMcpAuth(id, callbackUrl);
      }),
    [run],
  );

  const disconnect = useCallback(
    () =>
      run("disconnecting", async (current) => {
        const result = await disconnectMcp(url);
        if (!current()) return;
        // Local removal is already confirmed by the API. Do not retain an
        // authorized badge if a subsequent status request happens to fail.
        if (connection)
          publish({
            ...connection,
            status: "auth_required",
            has_credentials: false,
            expires_at: null,
            scopes: [],
            error: null,
          });
        setNotice(
          result.warning ||
            "Authorization cancelled. Agent bindings are unchanged.",
        );
      }),
    [url, connection, run, publish],
  );

  const pollingId =
    flow && (flow.status === "pending" || flow.status === "exchanging")
      ? flow.id
      : null;
  useEffect(() => {
    if (!pollingId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await getMcpAuthFlow(pollingId);
        if (!active || !mounted.current) return;
        if (value.status === "complete") {
          // Keep the polling effect alive across these awaited requests.
          // Updating flow first would run cleanup and drop their results.
          setPhase("checking");
          setError(null);
          try {
            const saved = await getMcpConnection(url);
            if (!active) return;
            publish(saved);
            const detected = await probeMcp(url, latest.current.headers);
            if (active) publish(detected);
          } catch (cause) {
            if (active) setError(mcpErrorText(cause));
          }
          if (active) {
            activeFlow.current = null;
            setPhase(null);
            setFlow(value);
          }
          return;
        }
        if (value.status !== "pending" && value.status !== "exchanging") {
          activeFlow.current = null;
          setFlow(value);
          setPhase(null);
          setError(
            value.error ||
              (value.status === "expired"
                ? "Sign-in timed out. Authorize again to continue."
                : null),
          );
          return;
        }
      } catch (cause) {
        if (active) setError(mcpErrorText(cause));
      }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollingId, url, publish]);

  return {
    connection,
    phase,
    flow,
    error,
    notice,
    busy: phase !== null,
    waiting: pollingId !== null,
    check,
    authorize,
    cancelSignIn,
    completeSignIn,
    disconnect,
  };
}

export type McpConnectionController = ReturnType<typeof useMcpConnection>;
