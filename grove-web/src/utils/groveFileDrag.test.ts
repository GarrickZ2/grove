import { afterEach, describe, expect, it } from "vitest";
import {
  GROVE_FILE_DRAG_TYPE, GROVE_FILE_LIST_DRAG_TYPE, beginGroveFileDrag, decodeGroveFileList, encodeGroveFileList,
  endGroveFileDrag, groveDragCount, groveDropPaths, setGroveFileDrag,
} from "./groveFileDrag";

function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => { data.set(type, value); },
  };
}

describe("grove file drag payload", () => {
  afterEach(() => endGroveFileDrag());

  it("round-trips a list in order without repeats or blanks", () => {
    expect(decodeGroveFileList(encodeGroveFileList(["a.md", "b.png", "a.md", " ", "c.txt"]))).toEqual(["a.md", "b.png", "c.txt"]);
  });

  it("rejects malformed list payloads", () => {
    expect(decodeGroveFileList("")).toEqual([]);
    expect(decodeGroveFileList("not json")).toEqual([]);
    expect(decodeGroveFileList('{"a":1}')).toEqual([]);
    expect(decodeGroveFileList('["a", 3, null, "b"]')).toEqual(["a", "b"]);
  });

  it("writes the list plus the first path for single-path receivers", () => {
    const dt = transfer();
    setGroveFileDrag(dt, ["out/a.md", "out/b.md"]);
    expect(dt.data.get(GROVE_FILE_DRAG_TYPE)).toBe("out/a.md");
    expect(decodeGroveFileList(dt.data.get(GROVE_FILE_LIST_DRAG_TYPE)!)).toEqual(["out/a.md", "out/b.md"]);
    expect(dt.data.get("text/plain")).toBe("out/a.md\nout/b.md");
    const single = transfer();
    setGroveFileDrag(single, ["out/a.md"]);
    expect(single.data.has(GROVE_FILE_LIST_DRAG_TYPE)).toBe(false);
  });

  it("reads the list first and falls back to the single path", () => {
    expect(groveDropPaths(transfer({ [GROVE_FILE_LIST_DRAG_TYPE]: '["x","y"]', [GROVE_FILE_DRAG_TYPE]: "x" }))).toEqual(["x", "y"]);
    expect(groveDropPaths(transfer({ [GROVE_FILE_LIST_DRAG_TYPE]: "broken", [GROVE_FILE_DRAG_TYPE]: "x" }))).toEqual(["x"]);
    expect(groveDropPaths(transfer())).toEqual([]);
  });

  it("knows how many files the drag in progress carries", () => {
    expect(groveDragCount([GROVE_FILE_DRAG_TYPE])).toBe(1);
    beginGroveFileDrag(3);
    expect(groveDragCount([GROVE_FILE_DRAG_TYPE, GROVE_FILE_LIST_DRAG_TYPE])).toBe(3);
    expect(groveDragCount(["Files"])).toBe(1);
  });
});
