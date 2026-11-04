import { emit } from "@tauri-apps/api/event";
import { useBanner, useConfig } from "../../context";
import { patchConfig } from "../../api";
import { isTauriShell } from "../../utils/tauriShell";

export type BuddyMotion = "lively" | "standard";
/** Tells an open mini window, which keeps its own copy of the config. */
export const BUDDY_MOTION_EVENT = "buddy-mini:motion";

/** Lively or Standard mini Buddy; saved on its own, outside the settings auto-save. */
export function useBuddyMotionSetting() {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const motion: BuddyMotion = config?.web.buddy_motion === "standard" ? "standard" : "lively";
  const setMotion = (next: BuddyMotion) => {
    void patchConfig({ web: { buddy_motion: next } })
      .then(() => { if (isTauriShell) void emit(BUDDY_MOTION_EVENT, next); return refresh(); })
      .catch(() => showBanner("Failed to save Mini Buddy motion", "error"));
  };
  return { motion, setMotion };
}
