import { useBanner, useConfig } from "../../context";
import { patchConfig } from "../../api";

/** Off by default: only people who run Grove on several machines need the switcher. */
export function useMultiMachineSetting() {
  const { config, refresh } = useConfig();
  const { showBanner } = useBanner();
  const multiMachine = config?.web?.multi_machine === true;
  const setMultiMachine = (next: boolean) => {
    void patchConfig({ web: { multi_machine: next } })
      .then(refresh)
      .catch(() => showBanner("Failed to save the setting", "error"));
  };
  return { multiMachine, setMultiMachine };
}
