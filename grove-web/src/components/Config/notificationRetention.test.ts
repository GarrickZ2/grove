import { describe, expect, it } from "vitest";
import { clampRetentionValue } from "./notificationRetention";

describe("clampRetentionValue", () => {
  it("floors and clamps to 1–365", () => {
    expect(clampRetentionValue("3.9")).toBe(3);
    expect(clampRetentionValue("0")).toBe(1);
    expect(clampRetentionValue("-4")).toBe(1);
    expect(clampRetentionValue("9999")).toBe(365);
  });

  it("ignores input that isn't a number", () => {
    expect(clampRetentionValue("abc")).toBeNull();
    expect(clampRetentionValue("Infinity")).toBeNull();
  });
});
