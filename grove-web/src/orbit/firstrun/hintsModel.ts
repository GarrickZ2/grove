/* Pure pieces of the first-turn hints: what to show and how a finished turn is read off the toolbar. */

export interface TurnHint {
  tool: string;
  /** Toolbar label, the fallback anchor when the button carries no `data-orbit-tool`. */
  label: string;
  title: string;
  body: string;
}

export const TURN_HINTS: TurnHint[] = [
  {
    tool: "review",
    label: "Code Review",
    title: "Review before you merge",
    body: "Look through what the agent changed and leave comments. Nothing merges until you say so.",
  },
  {
    tool: "notes",
    label: "Notes",
    title: "Notes are context",
    body: "Write goals or constraints for this task here. Agents in the task can read them through Grove.",
  },
];

/** The visible Orbit workspace toolbar, if a task is open. */
export function visibleBar(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(".ows-bar")).find((bar) => bar.getClientRects().length > 0) ?? null;
}

export function findHintAnchor(bar: ParentNode, hint: TurnHint): HTMLElement | null {
  const el = bar.querySelector<HTMLElement>(`[data-orbit-tool="${hint.tool}"]`)
    ?? bar.querySelector<HTMLElement>(`.ows-tb[aria-label="${hint.label}"]`);
  return el && !(el as HTMLButtonElement).disabled ? el : null;
}

export interface BarSnapshot { title: string; working: boolean }

export function snapshot(bar: HTMLElement | null): BarSnapshot | null {
  if (!bar) return null;
  return {
    title: bar.querySelector(".ows-bar-name")?.textContent ?? "",
    working: !!bar.querySelector(".ows-state.is-working"),
  };
}

/** A turn finished: the same task's toolbar went from Working to idle. */
export function turnFinished(previous: BarSnapshot | null, current: BarSnapshot | null): boolean {
  return !!previous && !!current && previous.working && !current.working && previous.title === current.title;
}
