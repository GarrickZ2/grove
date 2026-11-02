import { describe, expect, it } from "vitest";
import { orbitTabTitle } from "./orbitTabs";

describe("orbitTabTitle", () => {
  it("drops the #N suffix when the panel has one tab", () => {
    expect(orbitTabTitle("Code Review #1", 1)).toBe("Code Review");
    expect(orbitTabTitle("Agent #3", 1)).toBe("Agent");
  });
  it("keeps it when there are duplicates", () => {
    expect(orbitTabTitle("Terminal #2", 2)).toBe("Terminal #2");
  });
  it("leaves renamed tabs alone", () => {
    expect(orbitTabTitle("Logs", 1)).toBe("Logs");
    expect(orbitTabTitle("Build #fast", 1)).toBe("Build #fast");
  });
});
