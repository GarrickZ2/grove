import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitPermissionRequest, type OrbitPermission } from "./OrbitPermissionCard";

vi.mock("../../../ui", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

const request = (id: string): OrbitPermission => ({
  id,
  description: `Use ${id}`,
  options: [
    { option_id: "yes", name: "Yes", kind: "allow_once" },
    { option_id: "no", name: "No", kind: "reject_once" },
  ],
});

describe("Orbit permission request", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;

  it("answers a request once, then resets for the next request", () => {
    const onRespond = vi.fn(() => true);
    const first = request("read_notes");
    act(() => root.render(<OrbitPermissionRequest key={first.id} message={first} onRespond={onRespond} />));
    act(() => { button("Yes").click(); button("Yes").click(); button("No").click(); });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith("yes", "read_notes");
    expect(button("No").disabled).toBe(true);

    // The next request docks in the same place and is answerable.
    const second = request("memory_recall");
    act(() => root.render(<OrbitPermissionRequest key={second.id} message={second} onRespond={onRespond} />));
    expect(button("Yes").disabled).toBe(false);
    act(() => button("Yes").click());
    expect(onRespond).toHaveBeenLastCalledWith("yes", "memory_recall");
    expect(onRespond).toHaveBeenCalledTimes(2);
  });

  it("stays answerable when the response could not be sent", () => {
    const onRespond = vi.fn(() => false);
    act(() => root.render(<OrbitPermissionRequest message={request("a")} onRespond={onRespond} />));
    act(() => button("Yes").click());
    expect(button("Yes").disabled).toBe(false);
    act(() => button("Yes").click());
    expect(onRespond).toHaveBeenCalledTimes(2);
  });
});
