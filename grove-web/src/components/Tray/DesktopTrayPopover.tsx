/**
 * Desktop host for the menubar tray popover.
 *
 * Wires the platform-agnostic `TrayPopover` to Tauri commands (permission
 * resolution, open task / main / settings, pin + drag + resize) and hosts the
 * "Sync to phone" dialog. The phone page uses its own host (`PhoneTrayPanel`)
 * with HTTP-backed actions instead.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TrayPopover, type TrayPlatform } from "./TrayPopover";
import { RadioConnectDialog } from "../Blitz/RadioConnectDialog";
import { apiClient, AUTH_EXPIRED_EVENT, clearTabAuthorization, setDeviceSession, setSecretKey } from "../../api/client";
import { AuthRequestError, getAuthSession } from "../../api/auth";
import type { RemoteAuthorization } from "../../utils/tauriShell";

export function DesktopTrayPopover() {
  const [syncOpen, setSyncOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let unlisten: (() => void) | undefined;

    const prepareAuth = async () => {
      const current = ++generation;
      try {
        const info = await apiClient.get<{ required?: boolean }>("/api/v1/auth/info");
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
          console.error("[tray] auth bootstrap failed", error);
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

  if (!authReady) return null;

  const platform: TrayPlatform = {
    resolvePermission: (item, opt) => {
      apiClient
        .post<
          { projectId: string; taskId: string; chatId: string; optionId: string },
          { status?: string; error?: string }
        >("/api/v1/tray/resolve-permission", {
          projectId: item.project_id,
          taskId: item.task_id,
          chatId: item.chat_id,
          optionId: opt.option_id,
        })
        .then((res) => {
          if (res?.error) throw new Error(res.error);
        })
        .catch((e) => console.error("[tray] resolve failed", e));
    },
    openTask: (item) => {
      invoke("tray_open_task", {
        projectId: item.project_id,
        taskId: item.task_id,
        chatId: item.chat_id,
      }).catch((e) => console.error("[tray] open_task failed", e));
    },
    openMain: () =>
      invoke("tray_open_main").catch((e) => console.error("[tray] open_main failed", e)),
    openSettings: () =>
      invoke("tray_open_settings").catch((e) =>
        console.error("[tray] open_settings failed", e),
      ),
    syncToPhone: () => setSyncOpen(true),
    sendPrompt: async (item, text) => {
      const res = await apiClient.post<unknown, { status?: string; error?: string }>(
        "/api/v1/tray/send-prompt",
        {
          projectId: item.project_id,
          taskId: item.task_id,
          chatId: item.chat_id,
          text,
        },
      );
      if (res?.error) throw new Error(res.error);
    },
    // Desktop tray is text-only; voice (hold-to-record) is phone-only per spec.
    enableVoice: false,
    pinning: {
      isPinned: () => invoke<boolean>("tray_is_pinned"),
      setPinned: (v) => {
        invoke("tray_set_pinned", { pinned: v }).catch((e) =>
          console.error("[tray] set_pinned failed", e),
        );
      },
      startDragging: () => {
        getCurrentWindow()
          .startDragging()
          .catch((err) => console.error("[tray] startDragging failed", err));
      },
      startResize: () => {
        getCurrentWindow()
          .startResizeDragging("SouthEast")
          .catch((err) => console.error("[tray] startResizeDragging failed", err));
      },
    },
  };

  return (
    <>
      <TrayPopover platform={platform} />
      <RadioConnectDialog open={syncOpen} page="tray" onClose={() => setSyncOpen(false)} />
    </>
  );
}
