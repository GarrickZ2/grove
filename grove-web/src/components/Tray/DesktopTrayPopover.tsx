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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TrayPopover, type TrayPlatform } from "./TrayPopover";
import { RadioConnectDialog } from "../Blitz/RadioConnectDialog";
import { apiClient, setSecretKey } from "../../api/client";

export function DesktopTrayPopover() {
  const [syncOpen, setSyncOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retry: number | null = null;

    const prepareAuth = async () => {
      try {
        const info = await apiClient.get<{ required?: boolean }>("/api/v1/auth/info");
        if (!info.required) {
          if (!cancelled) setAuthReady(true);
          return;
        }

        const waitForVerifiedKey = async () => {
          const key = await invoke<string | null>("get_remote_auth_key").catch(() => null);
          if (cancelled) return;
          if (key) {
            setSecretKey(key);
            setAuthReady(true);
          } else {
            retry = window.setTimeout(() => void waitForVerifiedKey(), 250);
          }
        };
        await waitForVerifiedKey();
      } catch (error) {
        console.error("[tray] auth bootstrap failed", error);
      }
    };

    void prepareAuth();
    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
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
