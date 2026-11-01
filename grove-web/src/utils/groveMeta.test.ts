import { describe, expect, it } from "vitest";
import { parseGroveMetaSegments } from "./groveMeta";

describe("parseGroveMetaSegments", () => {
  it("reads Buddy messages in both the v1 and the legacy envelope", () => {
    const v1 = parseGroveMetaSegments('<grove-meta>{"v":1,"type":"buddy_message","data":{"buddy_id":"b","name":"Jack"},"system-prompt":"Sent by Jack"}</grove-meta>\nHello');
    expect(v1[0]).toMatchObject({ kind: "meta", envelope: { type: "buddy_message", data: { name: "Jack" } } });
    expect(v1[1]).toEqual({ kind: "text", content: "\nHello" });
    const legacy = parseGroveMetaSegments('<grove-meta>{"kind":"buddy_message","buddy_id":"b"}</grove-meta>\nHi');
    expect(legacy[0]).toMatchObject({ kind: "meta", envelope: { type: "buddy_message", data: { buddy_id: "b" } } });
  });

  it("keeps malformed envelopes as text", () => {
    expect(parseGroveMetaSegments("<grove-meta>{oops}</grove-meta>")).toEqual([{ kind: "text", content: "<grove-meta>{oops}</grove-meta>" }]);
  });
});
