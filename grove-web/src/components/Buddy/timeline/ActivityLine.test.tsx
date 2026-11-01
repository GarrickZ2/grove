import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuddiesMock } from "../../../api/buddies.mock";
import { ActivityLine } from "./ActivityLine";
import { friendlyStep } from "./activityLabels";
import type { Activity } from "./buddyTimelineState";

let host: HTMLDivElement, root: Root;
const buddy = createBuddiesMock().get("mock-release");
const activity: Activity = { kind: "activity", id: "turn", started: 1000, ended: 92000, steps: [{ id: "read", title: "Read MEMORY.md" }, { id: "command", title: "`rm -rf build`" }] };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value = activity) => act(() => root.render(<ActivityLine activity={value} buddy={buddy} />));

it("summarizes a finished turn without exposing steps", () => {
  render();
  expect(host.textContent).toBe("Worked for 1m 31s");
  expect(host.querySelector("button")).toBeNull();
});

it("shows only a plain-language status while working", () => {
  render({ ...activity, ended: undefined });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Running a command");
  expect(host.textContent).not.toContain("rm -rf");
  expect(host.querySelector("button")).toBeNull();
});

it("maps tool titles, including Buddy MCP names, to friendly phrases", () => {
  expect(friendlyStep("mcp__grove_buddy__list_projects")).toBe("Looking through projects");
  expect(friendlyStep("mcp__grove_buddy__buddy_list_projects")).toBe("Looking through projects");
  expect(friendlyStep("buddy_routine_create")).toBe("Setting up a routine");
  expect(friendlyStep("ToolSearch")).toBe("Looking for the right tool");
  expect(friendlyStep("mcp__grove_memory__memory_get_directory")).toBe("Checking memory");
  expect(friendlyStep("Something new")).toBe("Working…");
});
