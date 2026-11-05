import { NAVIGATION_KEY } from "./navigationState";

// Where someone was on each machine. These ids mean nothing on another one, so
// they travel with the machine instead of staying in this window's storage.
const SESSION_KEYS = [NAVIGATION_KEY];
const LOCAL_KEYS = ["grove-selected-project", "grove-buddy-selected", "grove-buddy-selected-group"];
const VIEW_PREFIX = "grove:machine-view:";

interface MachineView {
  session: Record<string, string>;
  local: Record<string, string>;
}

function snapshot(storage: Storage, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = storage.getItem(key);
    return value === null ? [] : [[key, value]];
  }));
}

function restore(storage: Storage, keys: string[], saved: Record<string, string> | undefined) {
  for (const key of keys) {
    const value = saved?.[key];
    if (value === undefined) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

/** Leave `from` as it is and pick up `to` where it was left. */
export function swapMachineView(from: string, to: string) {
  try {
    const view: MachineView = { session: snapshot(sessionStorage, SESSION_KEYS), local: snapshot(localStorage, LOCAL_KEYS) };
    localStorage.setItem(VIEW_PREFIX + from, JSON.stringify(view));
    const saved = JSON.parse(localStorage.getItem(VIEW_PREFIX + to) ?? "null") as MachineView | null;
    restore(sessionStorage, SESSION_KEYS, saved?.session);
    restore(localStorage, LOCAL_KEYS, saved?.local);
  } catch {
    // Without storage the machine still opens, on its default page.
  }
}
