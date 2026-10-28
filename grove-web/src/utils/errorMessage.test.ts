import { describe, expect, it } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("shows the message from Grove API error objects", () => {
    expect(errorMessage({ status: 500, message: "registry refresh failed: registry fetch HTTP 503" }))
      .toBe("registry refresh failed: registry fetch HTTP 503");
  });

  it("handles native errors and avoids displaying unhelpful objects", () => {
    expect(errorMessage(new Error("Network unavailable"))).toBe("Network unavailable");
    expect(errorMessage({ status: 500 }, "Refresh failed")).toBe("Refresh failed");
  });
});
