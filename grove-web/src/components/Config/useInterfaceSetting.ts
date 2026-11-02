import { useBanner, useConfig } from "../../context";
import { patchConfig } from "../../api";

export type InterfaceChoice = "orbit" | "workbench";

/** Orbit / Workbench choice; saved on its own, outside the settings auto-save. */
export function useInterfaceSetting() {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const current: InterfaceChoice = config?.web.interface === "orbit" ? "orbit" : "workbench";
  const switchTo = (next: InterfaceChoice) => {
    void patchConfig({ web: { interface: next } }).then(refresh).catch(() => showBanner("Failed to switch interface", "error"));
  };
  return { current, switchTo };
}
