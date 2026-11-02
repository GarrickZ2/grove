import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewCommentDraft } from "../../../../context";
import { OrbitCommentsTray, OrbitMemoryTray, OrbitQueueTray } from "./OrbitTrays";
import { commentAnchor } from "./trayModel";

vi.mock("../../../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));

const draft = (patch: Partial<PreviewCommentDraft> = {}): PreviewCommentDraft => ({
  id: "c1", source: "chat", projectId: "p", taskId: "t", filePath: "chat-a-35", fileName: "", rendererId: "chat",
  locator: { text: "the spinner row", selector: "", tagName: "p" } as PreviewCommentDraft["locator"],
  comment: "Align this with the avatar", createdAt: 1, ...patch,
});

describe("Orbit trays", () => {
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

  it("names a comment's anchor", () => {
    expect(commentAnchor(draft())).toEqual({ label: "Conversation · message 35", dir: "" });
    expect(commentAnchor(draft({ source: "review", filePath: "src/app/main.tsx", fileName: "main.tsx" }))).toEqual({ label: "main.tsx", dir: "src/app" });
  });

  it("lists comments as flat rows with the shared head and keeps every action", () => {
    const onUpdate = vi.fn();
    const onSend = vi.fn();
    const onRemove = vi.fn();
    const onClose = vi.fn();
    const drafts = [draft()];
    act(() => root.render(<OrbitCommentsTray drafts={drafts} onUpdate={onUpdate} onSend={onSend} onRemove={onRemove} onClose={onClose} />));
    expect(container.querySelector(".oc-tray-head")?.textContent).toContain("Comments· 1");
    const row = container.querySelector(".oc-row")!;
    expect(row.querySelector(".oc-row-text")?.textContent).toBe("Align this with the avatar");
    expect(row.querySelector(".oc-row-meta")?.textContent).toBe("Conversation · message 35");
    expect(row.querySelector(".oc-row-quote")?.textContent).toBe("“the spinner row”");

    act(() => container.querySelector<HTMLButtonElement>(".oc-tray-action")!.click());
    expect(onSend).toHaveBeenLastCalledWith(drafts);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send this comment"]')!.click());
    expect(onSend).toHaveBeenLastCalledWith([drafts[0]]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove comment"]')!.click());
    expect(onRemove).toHaveBeenCalledWith("c1");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close comments"]')!.click());
    expect(onClose).toHaveBeenCalled();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit comment"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".oc-row-edit")!;
    expect(textarea.value).toBe("Align this with the avatar");
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>(".oc-text-btn")).find((button) => button.textContent === "Save")!;
    act(() => save.click());
    expect(onUpdate).toHaveBeenCalledWith("c1", { comment: "Align this with the avatar" });
    expect(container.querySelector(".oc-row-edit")).toBeNull();
  });

  it("lists read memories with their tags", () => {
    act(() => root.render(<OrbitMemoryTray memories={[{ entity_id: "mem-1", title: "Release checklist", tags: [{ key: "area", value: "release" }] }]} />));
    expect(container.querySelector(".oc-tray-head")?.textContent).toContain("Memory· 1 read this turn");
    expect(container.querySelector(".oc-row-text")?.textContent).toBe("Release checklist");
    expect(container.querySelector(".oc-tag-quiet")?.textContent).toBe("release");
  });

  it("lists queued messages with their actions, flags failures and keeps the send mode", () => {
    const onModeChange = vi.fn();
    act(() => root.render(
      <OrbitQueueTray
        mode="separate"
        onModeChange={onModeChange}
        rows={[
          { key: "a", text: "Also check the dark theme", failed: false, actions: <button type="button">Now</button> },
          { key: "b", text: "Run the visual diff", failed: true, actions: <button type="button">Retry</button> },
        ]}
      />,
    ));
    const rows = container.querySelectorAll(".oc-row");
    expect(rows[0].querySelector(".oc-row-n")?.textContent).toBe("1");
    expect(rows[1].classList.contains("is-failed")).toBe(true);
    expect(rows[1].textContent).toContain("Failed to send");
    expect(rows[1].querySelector(".oc-row-actions")?.textContent).toBe("Retry");
    const compact = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent === "Compact")!;
    act(() => compact.click());
    expect(onModeChange).toHaveBeenCalledWith("compact");
  });

  it("says when the queue is empty", () => {
    act(() => root.render(<OrbitQueueTray mode="compact" onModeChange={vi.fn()} rows={[]} />));
    expect(container.querySelector(".oc-tray-empty")?.textContent).toBe("No queued messages.");
  });
});
