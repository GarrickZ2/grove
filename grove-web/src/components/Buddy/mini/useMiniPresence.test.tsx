import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SLEEP_AFTER_MS, useMiniPresence } from "./useMiniPresence";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), cursor: null as null | ((event: { payload: { x: number; y: number; near: boolean; over: boolean } }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_name: string, handler: typeof tauri.cursor) => { tauri.cursor = handler; return () => { tauri.cursor = null; }; } }));

type Props = { collapsed?: boolean; tone?: "idle" | "working"; lively?: boolean };
const seen = { current: null as unknown as ReturnType<typeof useMiniPresence> };
let host: HTMLDivElement, root: Root;
const bubble = { current: document.createElement("button") };
function Probe({ collapsed = true, tone = "idle", lively = true }: Props) {
  const presence = useMiniPresence({ collapsed, tone, activity: "a", lively, bubble });
  useEffect(() => { seen.current = presence; });
  return null;
}
const show = (props: Props = {}) => act(async () => { root.render(<Probe {...props} />); await Promise.resolve(); });
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("falls asleep when left alone, and wakes with a nearby cursor", async () => {
  await show();
  act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS); });
  expect(seen.current.sleeping).toBe(true);
  act(() => tauri.cursor!({ payload: { x: 0.5, y: -0.5, near: true, over: true } }));
  expect(seen.current.sleeping).toBe(false);
  expect(seen.current.waking).toBe(true);
  expect(bubble.current.style.getPropertyValue("--look-x")).toBe("0.5");
  act(() => { vi.advanceTimersByTime(1000); });
  expect(seen.current.waking).toBe(false);
});

it("a nearby cursor keeps it awake", async () => {
  await show();
  act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS - 1000); });
  act(() => tauri.cursor!({ payload: { x: 1, y: 0, near: true, over: false } }));
  act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS - 1000); });
  expect(seen.current.sleeping).toBe(false);
  expect(seen.current.following).toBe(true);
});

it("stops polling while working and never sleeps through it", async () => {
  await show();
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_track_cursor", { enabled: true });
  await show({ tone: "working" });
  expect(tauri.invoke).toHaveBeenLastCalledWith("buddy_mini_track_cursor", { enabled: false });
  act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS * 2); });
  expect(seen.current.sleeping).toBe(false);
});

it("standard motion never polls the cursor, and hover alone wakes it", async () => {
  await show({ lively: false });
  expect(tauri.invoke).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS); });
  expect(seen.current.sleeping).toBe(true);
  act(() => seen.current.notice());
  expect(seen.current.sleeping).toBe(false);
});
