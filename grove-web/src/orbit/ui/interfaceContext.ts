import { createContext, useContext } from "react";
import { readCachedOrbit } from "../firstrun/storage";

/**
 * Whether the app is showing the Orbit interface. Shared components (dialogs,
 * palettes) read it to pick their Orbit presentation; logic stays shared.
 * Defaults to false, so anything rendered outside the provider (tests, the
 * review page) keeps the Workbench markup.
 */
export const OrbitInterfaceContext = createContext(false);

/** Whether the config (and so the interface) has loaded. False outside the provider. */
export const OrbitInterfaceKnownContext = createContext(false);

export function useOrbitInterface(): boolean {
  return useContext(OrbitInterfaceContext);
}

/**
 * Orbit-or-not for screens that can draw before the config loads (sign-in,
 * splash, Welcome): the config's answer once known, otherwise the interface
 * the config reported last time in this browser (Workbench if never).
 */
export function useOrbitLook(): boolean {
  const orbit = useContext(OrbitInterfaceContext);
  const known = useContext(OrbitInterfaceKnownContext);
  return known ? orbit : readCachedOrbit();
}
