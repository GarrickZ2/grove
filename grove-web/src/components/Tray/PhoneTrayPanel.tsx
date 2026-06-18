/**
 * Phone host for the tray task panel.
 *
 * Served by the radio server at `/phone-tray`, authenticated with the one-time
 * token in the URL hash (stored to sessionStorage by `phone-tray-main.tsx`).
 * Reuses the shared `TrayPopover` presentation but routes its actions through
 * HTTP instead of Tauri (phones have no Tauri bridge), and seeds initial
 * state from `GET /api/v1/tray/chats` since a phone connects fresh with no
 * event history. Desktop-only chrome (pin / drag / settings / sync-to-phone)
 * is omitted by not supplying those platform callbacks; `openTask` IS
 * supplied so the existing-but-hidden "Open in app" icons in `TrayPopover`
 * (DoneRow, ReplyView, PermissionCard no-options fallback) become visible
 * and the whole-card click on RunningCard / PermissionCard jumps the
 * desktop to the tapped task.
 */

import { useEffect, useState } from "react";
import { TrayPopover, type TrayPlatform } from "./TrayPopover";
import { apiClient } from "../../api/client";

export function PhoneTrayPanel() {
  // Voice is only usable when audio transcription is configured. The tray QR
  // skips that check at start (tray is read/permission-first), so confirm it
  // here and only offer hold-to-talk when transcription will actually work.
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ enabled?: boolean; transcribe_provider?: string }>("/api/v1/ai/audio")
      .then((a) => {
        if (!cancelled) setVoiceEnabled(!!a.enabled && !!a.transcribe_provider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const platform: TrayPlatform = {
    resolvePermission: (item, opt) => {
      apiClient
        .post("/api/v1/tray/resolve-permission", {
          projectId: item.project_id,
          taskId: item.task_id,
          chatId: item.chat_id,
          optionId: opt.option_id,
        })
        .catch((e) => console.error("[phone-tray] resolve failed", e));
    },
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
    openTask: (item) => {
      // Fire-and-forget HTTP: the desktop's existing tray:navigate consumer
      // (App.tsx applyNavigate) handles project selection + Zen/Blitz mode
      // routing + chat deep-link in one go, so we don't need to surface a
      // result back to the phone. The shared TrayPopover gates the "Open"
      // icon visibility on this callback being defined, so without it the
      // phone would have no way to ask the desktop to focus a task.
      apiClient
        .post("/api/v1/tray/open", {
          projectId: item.project_id,
          taskId: item.task_id,
          chatId: item.chat_id,
        })
        .catch((e) => console.error("[phone-tray] open failed", e));
    },
    enableVoice: voiceEnabled,
    seedFromSnapshot: true,
  };

  return <TrayPopover platform={platform} />;
}
