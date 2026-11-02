import { useEffect, type ReactNode } from "react";
import { useConfig } from "../../context/ConfigContext";
import { writeCachedInterface } from "../firstrun/storage";
import { OrbitInterfaceContext, OrbitInterfaceKnownContext } from "./interfaceContext";

/** Provides the interface from `config.web.interface`. Mount inside ConfigProvider. */
export function OrbitInterfaceProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const known = !!config;
  const orbit = config?.web.interface === "orbit";
  // Remembered so the sign-in page and splash, drawn before the config loads, can match it.
  useEffect(() => {
    if (known) writeCachedInterface(orbit ? "orbit" : "workbench");
  }, [known, orbit]);
  return (
    <OrbitInterfaceKnownContext.Provider value={known}>
      <OrbitInterfaceContext.Provider value={orbit}>
        {children}
      </OrbitInterfaceContext.Provider>
    </OrbitInterfaceKnownContext.Provider>
  );
}
