import { useBanner, useConfig } from "../../context";
import { patchConfig } from "../../api";
import { terminalPositionOf, type TerminalPosition } from "../Tasks/IDELayout/orbitDock";

/** Where the terminal docks; saved on its own, outside the settings auto-save. */
export function useTerminalPositionSetting() {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const terminalPosition = terminalPositionOf(config?.web?.terminal_position);
  const setTerminalPosition = (next: TerminalPosition) => {
    void patchConfig({ web: { terminal_position: next } })
      .then(refresh)
      .catch(() => showBanner("Failed to save the terminal position", "error"));
  };
  return { terminalPosition, setTerminalPosition };
}
