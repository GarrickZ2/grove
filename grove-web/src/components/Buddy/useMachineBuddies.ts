import { useCallback, useEffect, useRef, useState } from "react";
import { listBuddiesAt } from "../../api/buddies";
import { listBuddyGroupsAt, mergeBuddyList, type BuddyListEntry } from "../../api/buddyGroups";
import { getHomeApiBase, getMachineApiBase, setMachineApiBase } from "../../api/client";
import { getMachines, openMachine, type MachineProfile, type PairedMachine } from "../../api/machines";
import { useConfig } from "../../context";
import { writeBuddyPreference } from "./buddyStorage";

export interface MachineBuddies {
  machine: MachineProfile;
  /** The machine this window is on: its Buddies are the live list. */
  current: boolean;
  /** Where to point the API to reach it; null for the home machine. */
  base: string | null;
  /** Its Buddies and groups. Null when out of reach. */
  buddies: BuddyListEntry[] | null;
}

export type BuddyTarget = { buddyId?: string; groupId?: string };

const REFRESH_MS = 15_000;

/** Switching machines rebuilds the app: start from what's known, so the sidebar
 *  keeps its shape instead of dropping its sections until the next load. */
let remembered: MachineBuddies[] = [];

const onThisMachine = (sections: MachineBuddies[]) =>
  sections.map((section) => ({ ...section, current: section.base === getMachineApiBase() }));

async function reach(machine: PairedMachine): Promise<string | null> {
  if (machine.status !== "online" || !machine.url) return null;
  return openMachine(machine.id).catch(() => null);
}

async function buddiesAt(base: string): Promise<BuddyListEntry[] | null> {
  const [buddies, groups] = await Promise.all([
    listBuddiesAt(base).catch(() => null),
    // Older machines have no groups; their Buddies are still worth listing.
    listBuddyGroupsAt(base).catch(() => []),
  ]);
  return buddies && mergeBuddyList(buddies, groups, null);
}

/** Every machine's Buddies, for a sidebar that spans them. Off with the switcher. */
export function useMachineBuddies(items: BuddyListEntry[]) {
  const { config } = useConfig();
  const enabled = config?.web?.multi_machine === true;
  const [sections, setSections] = useState(() => onThisMachine(remembered));
  const generation = useRef(0);
  const liveItems = useRef(items);
  useEffect(() => { liveItems.current = items; }, [items]);

  const load = useCallback(async () => {
    const request = ++generation.current;
    const overview = await getMachines().catch(() => null);
    if (!overview || request !== generation.current) return;
    const next = await Promise.all([
      (async (): Promise<MachineBuddies> => {
        const current = overview.current === overview.this.id;
        return {
          machine: overview.this,
          current,
          base: null,
          buddies: current ? liveItems.current : await buddiesAt(getHomeApiBase()),
        };
      })(),
      ...overview.machines.map(async (machine): Promise<MachineBuddies> => {
        const current = overview.current === machine.id;
        const base = current ? getMachineApiBase() : await reach(machine);
        return { machine, current, base, buddies: current ? liveItems.current : base ? await buddiesAt(base) : null };
      }),
    ]);
    if (request === generation.current) {
      remembered = overview.machines.length > 0 ? next : [];
      setSections(remembered);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void Promise.resolve().then(load);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [enabled, load]);

  /** Go to that machine, opening one of its Buddies or groups. */
  const openOn = useCallback((section: MachineBuddies, target: BuddyTarget) => {
    // The machine we're leaving shows its list from here on.
    remembered = remembered.map((known) => (known.current ? { ...known, buddies: liveItems.current } : known));
    setMachineApiBase(section.base);
    // After the switch, which restores that machine's own selection.
    if (target.groupId) writeBuddyPreference("selected-group", target.groupId);
    else {
      writeBuddyPreference("selected", target.buddyId ?? "");
      writeBuddyPreference("selected-group", "");
    }
  }, []);

  return { sections: enabled && sections.length > 1 ? sections : [], openOn };
}

