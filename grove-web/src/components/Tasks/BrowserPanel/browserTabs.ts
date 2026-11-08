import type { BrowserTarget } from "../../../api/browser";

export interface BrowserTab {
  tabId: string;
  targetId: string;
  title?: string;
  url?: string;
  active?: boolean;
}

export type TabsByBrowser = Partial<Record<BrowserTarget, BrowserTab[]>>;

/** The user's pick, kept only until the agent moves to another browser. */
export interface BrowserPick {
  target: BrowserTarget;
  agentOn: BrowserTarget | null;
}

export interface TabRow {
  target: BrowserTarget;
  tab: BrowserTab;
  /** On screen in the panel. */
  shown: boolean;
  /** The tab the agent's next command lands on. */
  agentHere: boolean;
}

/** A tab's key across both browsers. */
export function tabKey(target: BrowserTarget, tab: BrowserTab): string {
  return `${target}:${tab.targetId}`;
}

/** Which browser the panel shows: the agent's, unless the user picked one. */
export function shownBrowser(
  pick: BrowserPick | null,
  connected: BrowserTarget[],
  agentOn: BrowserTarget | null,
): BrowserTarget | null {
  if (pick && pick.agentOn === agentOn && connected.includes(pick.target)) return pick.target;
  return agentOn;
}

/**
 * The tabs the panel lists, test browser first. The test browser belongs to
 * the Task, so all its tabs are listed; in the user's own browser, only the
 * tabs the agent has been on (`used`). Tabs the user closed in the panel
 * (`hidden`) are left out.
 */
export function tabRows(
  tabs: TabsByBrowser,
  connected: BrowserTarget[],
  shown: BrowserTarget | null,
  agentOn: BrowserTarget | null,
  used: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): TabRow[] {
  return (["managed", "personal"] as const)
    .filter((target) => connected.includes(target))
    .flatMap((target) =>
      (tabs[target] ?? [])
        .filter((tab) => target === "managed" || used.has(tabKey(target, tab)))
        .filter((tab) => !hidden.has(tabKey(target, tab)))
        .map((tab) => ({
          target,
          tab,
          shown: target === shown && Boolean(tab.active),
          agentHere: target === agentOn && Boolean(tab.active),
        })),
    );
}
