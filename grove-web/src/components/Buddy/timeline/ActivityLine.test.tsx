import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuddiesMock } from "../../../api/buddies.mock";
import { ActivityLine } from "./ActivityLine";
import type { Activity } from "./buddyTimelineState";

let host: HTMLDivElement, root: Root;
const buddy = createBuddiesMock().get("mock-release");
const command = `python3 - <<'PY'\n${"very_long_unbroken_argument_".repeat(80)}\nprint('<script>example</script>')\nPY`;
const activity: Activity = { kind: "activity", id: "turn", started: 1000, ended: 92000, steps: [{ id: "read", title: "Read MEMORY.md" }, { id: "command", title: command }] };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value = activity) => act(() => root.render(<ActivityLine activity={value} buddy={buddy} />));
const toggle = () => host.querySelector<HTMLButtonElement>(".buddy-activity-line button")!;

it("starts with a compact turn summary and exposes a keyboard-focusable steps region", () => {
  render();
  expect(toggle().textContent).toBe("Worked for 1m 31s · 2 steps");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".buddy-activity-details")).toBeNull();
  act(() => toggle().click());
  const region = host.querySelector<HTMLElement>('[aria-label="Activity steps"]')!;
  expect(region.id).toBe(toggle().getAttribute("aria-controls"));
  expect(region.tabIndex).toBe(0);
  expect(region.querySelectorAll(".buddy-activity-step-toggle")).toHaveLength(2);
  expect(region.querySelector("pre")).toBeNull();
});

it("expands only the selected step, preserves its entire command and lets it collapse again", () => {
  render(); act(() => toggle().click());
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Show details for step 2"]')!;
  act(() => button.click());
  const detail = host.querySelector<HTMLPreElement>(".buddy-activity-step-content")!;
  expect(detail.textContent).toBe(command);
  expect(detail.tabIndex).toBe(0);
  expect(detail.id).toBe(button.getAttribute("aria-controls"));
  expect(host.querySelectorAll("pre")).toHaveLength(1);
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector('[aria-label="Show details for step 1"]')?.getAttribute("aria-expanded")).toBe("false");
  act(() => button.click());
  expect(host.querySelector("pre")).toBeNull();
  act(() => toggle().click());
  expect(host.querySelector(".buddy-activity-details")).toBeNull();
});

it("keeps an inspected step open when streaming updates append new steps", () => {
  const working = { ...activity, ended: undefined };
  render(working);
  expect(host.querySelector(".buddy-activity-summary")?.textContent).toBe(command);
  act(() => toggle().click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Show details for step 2"]')!.click());
  render({ ...working, steps: [...working.steps, { id: "search", title: "Web search" }] });
  expect(host.querySelector(".buddy-activity-summary")?.textContent).toBe("Web search");
  expect(host.querySelector("pre")?.textContent).toBe(command);
  expect(host.querySelectorAll(".buddy-activity-step-toggle")).toHaveLength(3);
});
