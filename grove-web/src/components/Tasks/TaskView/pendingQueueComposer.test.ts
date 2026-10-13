import { afterEach, describe, expect, it } from "vitest";
import { captureComposerDraft, restoreComposerDraft } from "./pendingQueueComposer";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

function composer(html: string) {
  const element = document.createElement("div");
  element.contentEditable = "true";
  element.tabIndex = 0;
  element.innerHTML = html;
  document.body.appendChild(element);
  return element;
}

describe("a pending message borrowing the composer", () => {
  it("restores the unsent draft's chips, raw files, and input modes after editing", () => {
    const html = 'Next task <span contenteditable="false" data-file="src/main.rs">main.rs</span><br>Keep this draft';
    const element = composer(html);
    const attachment = { name: "notes.md", pendingFile: new File(["notes"], "notes.md"), previewUrl: "blob:original" };
    const attachments = [attachment];
    const draft = captureComposerDraft(element, attachments, true, true);
    element.textContent = "Changed pending message";
    attachments.pop();

    restoreComposerDraft(element, draft);

    expect(element.innerHTML).toBe(html);
    expect(element.querySelector("[data-file]")?.getAttribute("data-file")).toBe("src/main.rs");
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]).toBe(attachment);
    expect(draft.attachments[0].pendingFile.name).toBe("notes.md");
    expect(draft.terminalMode).toBe(true);
    expect(draft.expanded).toBe(true);
  });

  it("restores a caret range across reconstructed nested nodes", () => {
    const element = composer("First <span>second</span> third");
    const range = document.createRange();
    range.setStart(element.firstChild!, 2);
    range.setEnd(element.querySelector("span")!.firstChild!, 4);
    window.getSelection()?.addRange(range);
    const draft = captureComposerDraft(element, [], false, false);
    element.textContent = "Pending content";

    restoreComposerDraft(element, draft);

    const restored = window.getSelection()!.getRangeAt(0);
    expect(restored.startContainer).toBe(element.firstChild);
    expect(restored.startOffset).toBe(2);
    expect(restored.endContainer).toBe(element.querySelector("span")!.firstChild);
    expect(restored.endOffset).toBe(4);
    expect(window.getSelection()?.toString()).toBe("rst seco");
  });

  it("restores an attachment-only draft without stealing focus on navigation", () => {
    const element = composer("");
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const draft = captureComposerDraft(element, [{ name: "layout.png" }], false, false);
    element.textContent = "Pending text";

    restoreComposerDraft(element, draft, false);

    expect(element.innerHTML).toBe("");
    expect(draft.attachments[0].name).toBe("layout.png");
    expect(document.activeElement).toBe(other);
  });
});
