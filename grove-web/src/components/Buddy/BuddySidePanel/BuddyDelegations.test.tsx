import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Buddy, BuddyDelegation } from "../../../api/buddies";
import { BuddyDelegationsContext, type BuddyDelegationsValue } from "../delegations/buddyDelegationsContext";
import { BuddyNavigationContext } from "../buddyNavigation";
import { BuddyDelegations } from "./BuddyDelegations";

vi.mock("../../../context", () => ({ useProject: () => ({ projects: [{ id: "repo", name: "Grove" }] }) }));
vi.mock("../../ui/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock("../../Dialogs", () => ({ ConfirmDialog: ({ isOpen, confirmLabel, onConfirm }: { isOpen: boolean; confirmLabel: string; onConfirm: () => void }) => isOpen ? <button onClick={onConfirm}>{confirmLabel}</button> : null }));

const buddy = { id: "b", name: "Scout", project_hash: "buddy-project", local_task_id: "_local", active_session_id: "s" } as Buddy;
const delegation = (id: string, status: BuddyDelegation["status"], extra: Partial<BuddyDelegation> = {}): BuddyDelegation => ({ id, title: `Task ${id}`, brief: `Brief ${id}`, status, from_session: "s", target_project: "repo", target_task: "t", target_session: `${id}-session`, last_result: null, created_at: "2026-10-31T10:00:00Z", updated_at: "2026-10-31T10:00:00Z", completed_at: null, ...extra });

let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value: Partial<BuddyDelegationsValue>, navigate = vi.fn(async () => {})) => act(() => root.render(
  <BuddyNavigationContext.Provider value={{ interfaceName: "Grove", navigate }}><BuddyDelegationsContext.Provider value={{ items: [], error: null, requests: {}, cancel: vi.fn(async () => {}), refresh: vi.fn(async () => {}), show: vi.fn(), focused: null, ...value }}><BuddyDelegations buddy={buddy} /></BuddyDelegationsContext.Provider></BuddyNavigationContext.Provider>));
const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent?.includes(text))!;

it("groups delegations, expands the focused item, and opens or cancels it", async () => {
  const cancel = vi.fn(async () => {}); const navigate = vi.fn(async () => {});
  render({ items: [delegation("done", "done", { last_result: "All green" }), delegation("wait", "waiting"), delegation("run", "running", { target_project: "buddy-project" })], focused: "done", cancel }, navigate);
  expect([...host.querySelectorAll("h3")].map(node => node.textContent)).toEqual(["Needs you", "Running", "Done"]);
  expect([...host.querySelectorAll(".buddy-delegation-pill")].map(node => node.textContent)).toEqual(["Waiting", "Running", "Done"]);
  expect(host.querySelector(".buddy-delegation.is-running")?.textContent).toContain("Scout ·");
  expect(host.querySelector(".buddy-delegation.is-waiting")?.textContent).toContain("Grove · t ·");
  expect(host.textContent).toContain("All green");
  // Waiting work shows its actions without being opened, but keeps the brief folded.
  expect(host.querySelector(".buddy-delegation.is-waiting")?.textContent).toContain("Open in Grove");
  expect(host.textContent).not.toContain("Brief wait");
  await act(async () => button("Task wait").click());
  expect(host.textContent).toContain("Brief wait");
  await act(async () => button("Open in Grove").click());
  expect(navigate).toHaveBeenCalledWith({ projectId: "repo", taskId: "t", chatId: "wait-session" });
  await act(async () => button("Cancel").click());
  await act(async () => button("Cancel delegation").click());
  expect(cancel).toHaveBeenCalledWith("wait");
  // Self delegations run inside the Buddy's own Project, which never opens in the shell.
  await act(async () => button("Task run").click());
  const running = host.querySelector(".buddy-delegation.is-running")!;
  expect(running.textContent).toContain("Brief run");
  expect(running.textContent).not.toContain("Open in Grove");
});

it("clamps a long brief behind a toggle", async () => {
  render({ items: [delegation("long", "running", { brief: "## Background\n" + "line\n".repeat(10) })], focused: "long" });
  expect(host.querySelector(".buddy-delegation-brief.is-clamped")).not.toBeNull();
  await act(async () => button("Show full brief").click());
  expect(host.querySelector(".buddy-delegation-brief.is-clamped")).toBeNull();
  expect(button("Show less")).toBeDefined();
});

it("explains the empty state", () => {
  render({});
  expect(host.textContent).toContain("No delegations yet");
});
