import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("sends the selected approval option and request id, then renders its resolved state", () => {
  const respond = vi.fn();
  const approval = { kind: "approval" as const, id: "req", title: "Write file", detail: "1\n2\n3\n4\n5\n6\n7", options: [{ option_id: "yes", name: "Allowed once", kind: "allow_once" }] };
  act(() => root.render(<ApprovalCard approval={approval} connected onRespond={respond} />));
  expect(host.querySelector("pre")?.textContent).not.toContain("7");
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Allowed once")!.click());
  expect(respond).toHaveBeenCalledWith("req", "yes");
  act(() => root.render(<ApprovalCard approval={{ ...approval, resolved: "yes" }} connected onRespond={respond} />));
  expect(host.querySelector(".buddy-resolved")?.textContent).toContain("Allowed once · Write file");
});
it("validates required questions and submits structured answers with shared markdown serialization", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  act(() => root.render(<QuestionCard question={{ kind: "question", id: "q", definition: { title: "Pick a branch", questions: [{ id: "branch", title: "Branch", type: "single_choice", required: true, options: [{ id: "main", label: "Main" }] }] } }} connected onSubmit={submit} onSkip={vi.fn()} onOpen={vi.fn()} />));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submit).not.toHaveBeenCalled(); expect(host.textContent).toContain("Branch is required");
  act(() => [...host.querySelectorAll("button")].find(b => b.textContent === "Main")!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submit).toHaveBeenCalledWith({ branch: "main" }, expect.stringContaining("Branch: Main"));
});
