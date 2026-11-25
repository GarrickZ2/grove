import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentErrorMessage, AttachmentError, checkAttachable, MAX_ATTACHMENT_BYTES, prepareFileAttachment, readFileAsBase64 } from "./chatAttachments";

/** A dropped file the system won't let the page read: name and size, no content. */
function denyReads() {
  vi.stubGlobal("FileReader", class {
    error = new DOMException("The I/O read operation failed.", "NotReadableError");
    onerror: (() => void) | null = null;
    readAsDataURL() { queueMicrotask(() => this.onerror?.()); }
  });
}

afterEach(() => vi.unstubAllGlobals());

const REASON = "Couldn't read report.doc. Save it to another folder and attach it again.";

describe("attaching a file that can't be read", () => {
  it.each(["application/msword", "", "image/png", "audio/mpeg"])("refuses it while choosing (type %j)", async (type) => {
    denyReads();
    const result = prepareFileAttachment(new File(["content"], "report.doc", { type }));
    await expect(result).rejects.toBeInstanceOf(AttachmentError);
    await expect(result).rejects.toThrow(REASON);
  });

  it("names the file when it becomes unreadable before sending", async () => {
    denyReads();
    await expect(readFileAsBase64(new File(["content"], "report.doc"))).rejects.toThrow(REASON);
  });

  it("never hides the failure behind an unnamed browser error", () => {
    expect(attachmentErrorMessage(new File([], "report.doc"), new DOMException("The I/O read operation failed."))).toBe(REASON);
  });
});

describe("attaching a readable file", () => {
  it("keeps a document for upload and reads it whole", async () => {
    const file = new File(["hello"], "notes.md");
    expect((await prepareFileAttachment(file)).pendingFile).toBe(file);
    expect(await readFileAsBase64(file)).toBe(btoa("hello"));
  });

  it("accepts an empty file", async () => {
    const file = new File([], "empty.txt");
    await expect(checkAttachable(file)).resolves.toBeUndefined();
    expect(await readFileAsBase64(file)).toBe("");
  });

  it("refuses a file over the upload limit", async () => {
    const file = new File(["x"], "video.mov");
    Object.defineProperty(file, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
    await expect(prepareFileAttachment(file)).rejects.toThrow("video.mov is too large");
  });
});
