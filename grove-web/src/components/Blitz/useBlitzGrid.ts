import { useState, useCallback, useEffect, useRef } from "react";

export type GridLayout = "1" | "2" | "2x2" | "3x2";

export const GRID_LAYOUTS: ReadonlyArray<GridLayout> = ["1", "2", "2x2", "3x2"];

export function slotCountFor(layout: GridLayout): number {
  switch (layout) {
    case "1": return 1;
    case "2": return 2;
    case "2x2": return 4;
    case "3x2": return 6;
  }
}

export interface SlotAssignment {
  projectId: string;
  projectName: string;
  taskId: string;
  taskName: string;
  chatId: string;
  chatName: string;
}

export interface BlitzGridState {
  version: 1;
  layout: GridLayout;
  assignments: Array<SlotAssignment | null>;
}

const STORAGE_KEY = "grove:blitz-grid";
const DEFAULT_LAYOUT: GridLayout = "2x2";
const PERSIST_DEBOUNCE_MS = 200;

function defaultState(): BlitzGridState {
  return {
    version: 1,
    layout: DEFAULT_LAYOUT,
    assignments: new Array(slotCountFor(DEFAULT_LAYOUT)).fill(null),
  };
}

function hydrate(): BlitzGridState {
  if (typeof window === "undefined") return defaultState();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaultState();
  }
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw) as Partial<BlitzGridState>;
    const layout: GridLayout =
      typeof parsed.layout === "string" && (GRID_LAYOUTS as readonly string[]).includes(parsed.layout)
        ? (parsed.layout as GridLayout)
        : DEFAULT_LAYOUT;
    const expectedCount = slotCountFor(layout);
    const rawAssignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];
    const assignments: Array<SlotAssignment | null> = new Array(expectedCount)
      .fill(null)
      .map((_, i) => {
        const a = rawAssignments[i];
        if (
          a &&
          typeof a === "object" &&
          typeof (a as SlotAssignment).projectId === "string" &&
          typeof (a as SlotAssignment).projectName === "string" &&
          typeof (a as SlotAssignment).taskId === "string" &&
          typeof (a as SlotAssignment).taskName === "string" &&
          typeof (a as SlotAssignment).chatId === "string" &&
          typeof (a as SlotAssignment).chatName === "string"
        ) {
          return a as SlotAssignment;
        }
        return null;
      });
    return { version: 1, layout, assignments };
  } catch {
    return defaultState();
  }
}

export interface UseBlitzGridResult {
  layout: GridLayout;
  assignments: Array<SlotAssignment | null>;
  setLayout: (next: GridLayout) => void;
  assign: (slotIdx: number, assignment: SlotAssignment) => void;
  clearSlot: (slotIdx: number) => void;
}

export function useBlitzGrid(): UseBlitzGridResult {
  const [state, setState] = useState<BlitzGridState>(hydrate);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStateRef = useRef(state);
  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        console.warn("[useBlitzGrid] localStorage write failed", err);
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
      }
    };
  }, [state]);

  useEffect(() => {
    return () => {
      // Cleanup-on-unmount: flush the latest state synchronously so a
      // change made within the debounce window is not lost when the
      // component unmounts (e.g., user toggles grid view off in Blitz).
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(latestStateRef.current));
      } catch (err) {
        console.warn("[useBlitzGrid] unmount flush failed", err);
      }
    };
  }, []);

  const setLayout = useCallback((next: GridLayout) => {
    setState((prev) => {
      const nextCount = slotCountFor(next);
      const nextAssignments = new Array<SlotAssignment | null>(nextCount).fill(null);
      for (let i = 0; i < Math.min(prev.assignments.length, nextCount); i++) {
        nextAssignments[i] = prev.assignments[i];
      }
      return { ...prev, layout: next, assignments: nextAssignments };
    });
  }, []);

  const assign = useCallback((slotIdx: number, assignment: SlotAssignment) => {
    setState((prev) => {
      if (slotIdx < 0 || slotIdx >= prev.assignments.length) return prev;
      const nextAssignments = prev.assignments.slice();
      nextAssignments[slotIdx] = assignment;
      return { ...prev, assignments: nextAssignments };
    });
  }, []);

  const clearSlot = useCallback((slotIdx: number) => {
    setState((prev) => {
      if (slotIdx < 0 || slotIdx >= prev.assignments.length) return prev;
      const nextAssignments = prev.assignments.slice();
      nextAssignments[slotIdx] = null;
      return { ...prev, assignments: nextAssignments };
    });
  }, []);

  return {
    layout: state.layout,
    assignments: state.assignments,
    setLayout,
    assign,
    clearSlot,
  };
}
