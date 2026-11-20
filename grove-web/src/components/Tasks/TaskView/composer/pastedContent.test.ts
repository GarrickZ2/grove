import { describe, expect, it } from "vitest";
import { readPastedContent } from "./pastedContent";

function clipboard({ files = [], text = "", itemsOnly = false }: { files?: File[]; text?: string; itemsOnly?: boolean }): DataTransfer {
  return {
    files: itemsOnly ? [] : files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => (type === "text/plain" ? text : ""),
  } as unknown as DataTransfer;
}

const image = new File(["x"], "image.png", { type: "image/png" });

describe("readPastedContent", () => {
  it("keeps the text of a paste that mixes text and images", () => {
    const pasted = readPastedContent(clipboard({ files: [image], text: "实现流程如下：\n第一步" }));
    expect(pasted.files).toEqual([image]);
    expect(pasted.text).toBe("实现流程如下：\n第一步");
  });

  it("drops the file names a Finder copy carries as text", () => {
    const other = new File(["y"], "notes.md");
    expect(readPastedContent(clipboard({ files: [image, other], text: "image.png\rnotes.md" })).text).toBe("");
    expect(readPastedContent(clipboard({ files: [image], text: "/Users/me/Desktop/image.png" })).text).toBe("");
  });

  it("reads files exposed only as clipboard items", () => {
    const pasted = readPastedContent(clipboard({ files: [image], text: "caption", itemsOnly: true }));
    expect(pasted.files).toEqual([image]);
    expect(pasted.text).toBe("caption");
  });

  it("passes plain text through when there are no files", () => {
    expect(readPastedContent(clipboard({ text: "image.png" }))).toEqual({ files: [], text: "image.png" });
  });
});
