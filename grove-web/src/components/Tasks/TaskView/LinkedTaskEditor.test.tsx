// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LinkedTaskEditor } from "./LinkedTaskEditor";

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../context", () => ({
  useProject: () => ({ projects: [{ id: "own", name: "Own" }] }),
  useTheme: () => ({ theme: { accentPalette: [] } }),
}));
vi.mock("../../../utils/projectStyle", () => ({ getProjectStyle: () => ({ color: { bg: "", fg: "" }, Icon: () => null }) }));
vi.mock("../../../orbit/ui/interfaceContext", () => ({ useOrbitInterface: () => false }));
vi.mock("../../../orbit/ui/panelSlots", () => ({ useInPanelShell: () => false }));
const linker = vi.hoisted(() => ({ projects: [{ id: "more", name: "More", project_type: "repo", task_count: 0 }], link: vi.fn() }));
vi.mock("./useProjectLinker", () => ({
  NO_LINKABLE_PROJECTS: "None",
  useProjectLinker: () => ({ ...linker, disabled: false, error: null, loading: false, hasReviewable: false }),
}));
vi.mock("./TaskEditor", async () => {
  const { useState } = await import("react");
  return {
    TaskEditor: ({ projectId, taskId, treeTitle }: { projectId: string; taskId: string; treeTitle?: React.ReactNode }) => {
      useState(() => { mounts.count += 1; return null; });
      return <div><span className="files">{projectId}/{taskId}</span>{treeTitle}</div>;
    },
  };
});

const linked = [{ projectId: "other", taskId: "_local", name: "Other", isGitRepo: true }];
let host: HTMLDivElement;
let root: Root;
const render = (linkedProjects?: typeof linked) => act(() => root.render(
  <LinkedTaskEditor projectId="own" taskId="task" onClose={() => {}} linkedProjects={linkedProjects} />,
));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  mounts.count = 0;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

it("keeps the plain heading without linked Projects", () => {
  render([]);
  expect(host.querySelector(".files")?.textContent).toBe("own/task");
  expect(host.querySelector(".review-project-trigger")).toBeNull();
});

it("switches to a linked Project's Local Task in a fresh editor and remembers it", () => {
  render(linked);
  const trigger = host.querySelector<HTMLButtonElement>(".review-project-trigger")!;
  expect(trigger.getAttribute("aria-label")).toBe("Editing Own. Switch project");
  act(() => trigger.click());
  // Portaled: the file tree sidebar clips overflow.
  const option = [...document.body.querySelectorAll<HTMLButtonElement>(".review-project-pop [role=option]")].find((item) => item.textContent?.includes("Other"))!;
  act(() => option.click());
  expect(host.querySelector(".files")?.textContent).toBe("other/_local");
  expect(mounts.count).toBe(2);
  expect(sessionStorage.getItem("grove:editor-target:own:task")).toBe("other");
});

it("links another Project from the switcher menu", () => {
  render(linked);
  act(() => host.querySelector<HTMLButtonElement>(".review-project-trigger")!.click());
  act(() => document.body.querySelector<HTMLButtonElement>(".review-project-link")!.click());
  // The menu gave way to the picker.
  expect(document.body.querySelector(".review-project-menu")).toBeNull();
  const option = [...document.body.querySelectorAll<HTMLButtonElement>("[aria-label='Link Project'] [role=option]")].find((item) => item.textContent?.includes("More"))!;
  act(() => option.click());
  expect(linker.link).toHaveBeenCalledWith(linker.projects[0]);
  expect(document.body.querySelector("[aria-label='Link Project']")).toBeNull();
});

it("falls back to the task's own files when the linked Project goes away", () => {
  sessionStorage.setItem("grove:editor-target:own:task", "other");
  render(linked);
  expect(host.querySelector(".files")?.textContent).toBe("other/_local");
  render([]);
  expect(host.querySelector(".files")?.textContent).toBe("own/task");
});
