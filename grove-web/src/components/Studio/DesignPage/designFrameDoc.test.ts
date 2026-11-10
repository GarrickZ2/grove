import { describe, expect, it } from "vitest";
import { buildDesignDocument } from "./designFrameDoc";

const options = { frameId: "f", filesBase: "/files/", accent: "#000", version: "1" };

describe("buildDesignDocument", () => {
  it("puts the base and bridge at the start of the head", () => {
    const html = buildDesignDocument("<html><head><title>A</title></head><body></body></html>", options);
    expect(html.indexOf("<head><base href=\"/files/\">")).toBeGreaterThan(-1);
    expect(html.indexOf("<base")).toBeLessThan(html.indexOf("<title>"));
  });

  it("does not take a header for the head", () => {
    const html = buildDesignDocument("<html><body><header class=\"top\">Hi</header></body></html>", options);
    expect(html.startsWith("<html><head><base href=\"/files/\">")).toBe(true);
    expect(html).toContain("<header class=\"top\">Hi</header>");
  });

  it("leads a page that has neither", () => {
    const html = buildDesignDocument("<header>Hi</header>", options);
    expect(html.startsWith("<base href=\"/files/\">")).toBe(true);
    expect(html.endsWith("<header>Hi</header>")).toBe(true);
  });
});
