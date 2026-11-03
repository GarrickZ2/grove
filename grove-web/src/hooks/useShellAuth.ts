import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { apiClient, AUTH_EXPIRED_EVENT, clearTabAuthorization, setDeviceSession, setSecretKey } from "../api/client";
import { AuthRequestError, getAuthSession } from "../api/auth";
import type { RemoteAuthorization } from "../utils/tauriShell";

/**
 * Credentials for a secondary desktop window (menubar popover, mini Buddy).
 * Local servers need none; a signed-in server takes the main window's shell
 * credential via `get_remote_auth`, refreshed when it changes or expires.
 * `remoteServer` is true when the server requires sign-in.
 */
export function useShellAuth(): { authReady: boolean; remoteServer: boolean } {
  const [authReady, setAuthReady] = useState(false);
  // Signed-in servers (`grove mobile`) serve phones directly; the separate
  // phone task panel and its bearer-token server are local-only.
  const [remoteServer, setRemoteServer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let unlisten: (() => void) | undefined;

    const prepareAuth = async () => {
      const current = ++generation;
      try {
        const info = await apiClient.get<{ required?: boolean }>("/api/v1/auth/info");
        if (!cancelled && current === generation) setRemoteServer(!!info.required);
        if (!info.required) {
          if (!cancelled && current === generation) setAuthReady(true);
          return;
        }
        const authorization = await invoke<RemoteAuthorization | null>("get_remote_auth");
        if (cancelled || current !== generation) return;
        clearTabAuthorization();
        setAuthReady(false);
        if (!authorization) {
          return;
        }
        if (authorization.deviceId) {
          setDeviceSession(authorization.deviceId, authorization.signingKey);
          // A stale shell credential cannot keep a revoked tray mounted.
          await getAuthSession();
        } else {
          setSecretKey(authorization.signingKey);
        }
        if (!cancelled && current === generation) setAuthReady(true);
      } catch (error) {
        if (cancelled || current !== generation) return;
        const revoked = error instanceof AuthRequestError && error.status === 401 && error.code === 'AUTH_REVOKED';
        if (revoked) clearTabAuthorization();
        setAuthReady(false);
        if (!revoked) {
          console.error("[shell] auth bootstrap failed", error);
        }
      }
    };

    const expired = () => {
      setAuthReady(false);
      clearTabAuthorization();
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    const online = () => { void prepareAuth(); };
    window.addEventListener('online', online);
    void listen("grove-remote-auth-changed", () => { void prepareAuth(); }).then(stop => {
      if (cancelled) stop();
      else { unlisten = stop; void prepareAuth(); }
    }).catch(() => { if (!cancelled) void prepareAuth(); });
    return () => {
      cancelled = true;
      generation++;
      unlisten?.();
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
      window.removeEventListener('online', online);
    };
  }, []);

  return { authReady, remoteServer };
}
