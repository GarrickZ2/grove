import { describe, expect, it } from "vitest";
import { keycapParts } from "./keycaps";

describe("keycapParts", () => {
  it("splits a combo into one cap per key", () => {
    const parts = keycapParts("Cmd+Shift+K");
    expect(parts).toHaveLength(3);
    expect(parts[parts.length - 1]).toBe("K");
  });

  it("keeps a single key as one cap", () => {
    expect(keycapParts("Escape")).toHaveLength(1);
  });
});
