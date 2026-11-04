import { useBanner, useConfig } from "../../context";
import { patchConfig } from "../../api";

export type SendMode = "queue" | "interrupt";

/** Queue or Interrupt while the agent works; saved on its own, outside the settings auto-save. */
export function useSendModeSetting() {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const sendMode: SendMode = config?.web?.send_mode === "interrupt" ? "interrupt" : "queue";
  const setSendMode = (next: SendMode) => {
    void patchConfig({ web: { send_mode: next } })
      .then(refresh)
      .catch(() => showBanner("Failed to save the sending setting", "error"));
  };
  return { sendMode, setSendMode };
}
