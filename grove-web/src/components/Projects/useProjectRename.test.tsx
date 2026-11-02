import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectRename, validateProjectName } from "./useProjectRename";

let container: HTMLDivElement;
let root: Root;
const latest: { value?: ReturnType<typeof useProjectRename> } = {};
const current = () => latest.value!;

function Harness({ onRename }: { onRename: (name: string) => Promise<void> }) {
  const value = useProjectRename("grove", onRename);
  const { isEditing, inputRef } = value;
  useEffect(() => { latest.value = value; });
  return isEditing ? <input ref={inputRef} /> : null;
}

const enter = { key: "Enter", preventDefault: () => {} } as unknown as React.KeyboardEvent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("validateProjectName", () => {
  it("rejects empty, long, and path-like names", () => {
    expect(validateProjectName("")).toMatch(/empty/);
    expect(validateProjectName("x".repeat(129))).toMatch(/128/);
    expect(validateProjectName("a/b")).toMatch(/slashes/);
    expect(validateProjectName("ok name")).toBeNull();
  });
});

describe("useProjectRename", () => {
  it("submits a trimmed new name and leaves edit mode", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    act(() => root.render(<Harness onRename={onRename} />));
    act(() => current().beginEditing());
    expect(current().isEditing).toBe(true);
    act(() => current().changeName("  grove-2 "));
    await act(async () => { current().handleKeyDown(enter); });
    expect(onRename).toHaveBeenCalledWith("grove-2");
    expect(current().isEditing).toBe(false);
  });

  it("skips unchanged names and keeps a failed edit visible", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error("Name taken"));
    act(() => root.render(<Harness onRename={onRename} />));
    act(() => current().beginEditing());
    await act(async () => { current().handleKeyDown(enter); });
    expect(onRename).not.toHaveBeenCalled();
    expect(current().isEditing).toBe(false);

    act(() => current().beginEditing());
    act(() => current().changeName("bad/name"));
    await act(async () => { current().handleKeyDown(enter); });
    expect(current().renameError).toMatch(/slashes/);
    expect(onRename).not.toHaveBeenCalled();

    act(() => current().changeName("taken"));
    expect(current().renameError).toBeNull();
    await act(async () => { current().handleKeyDown(enter); });
    expect(current().renameError).toBe("Name taken");
    expect(current().isEditing).toBe(true);
    expect(current().editName).toBe("taken");
  });
});
