// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalErrorBoundary } from "./GlobalErrorBoundary";
import {
  createClientErrorReport,
  formatClientErrorReport,
  installGlobalErrorHandlers,
  setClientAppVersion,
} from "./clientErrorReport";

describe("global client error recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    setClientAppVersion("1.2.3-test");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
    vi.restoreAllMocks();
  });

  it("replaces a crashed app with reload and copy-diagnostics actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const CrashedApp = () => {
      throw new Error("Sketch render failed");
    };

    act(() => {
      root.render(
        <GlobalErrorBoundary>
          <CrashedApp />
        </GlobalErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Reload Grove to continue");
    expect(container.textContent).toContain("Copy diagnostics");
    expect(consoleError).toHaveBeenCalledWith(
      "[GroveError] Unhandled application error",
      expect.objectContaining({
        version: "1.2.3-test",
        errorMessage: "Sketch render failed",
        componentStack: expect.stringContaining("CrashedApp"),
      }),
    );

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy diagnostics",
    );
    expect(copyButton).toBeDefined();
    await act(async () => copyButton?.click());

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Error: Error: Sketch render failed"),
    );
    expect(container.textContent).toContain("Diagnostics copied");
  });

  it("formats a developer-readable crash report", () => {
    const report = createClientErrorReport(new TypeError("bad settings"), {
      source: "react-uncaught",
      componentStack: "\n    at SettingsPage",
    });
    const text = formatClientErrorReport(report);

    expect(text).toContain("Grove crash report");
    expect(text).toContain("Version: 1.2.3-test");
    expect(text).toContain("TypeError: bad settings");
    expect(text).toContain("at SettingsPage");
  });

  it("captures browser errors and unhandled promise rejections", () => {
    const uninstall = installGlobalErrorHandlers();
    try {
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error("event handler failed"),
          message: "event handler failed",
        }),
      );
      const rejection = new Event("unhandledrejection");
      Object.defineProperty(rejection, "reason", {
        value: new Error("async task failed"),
      });
      window.dispatchEvent(rejection);
    } finally {
      uninstall();
    }

    expect(consoleError).toHaveBeenCalledWith(
      "[GroveError] Unhandled application error",
      expect.objectContaining({
        source: "window-error",
        errorMessage: "event handler failed",
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[GroveError] Unhandled application error",
      expect.objectContaining({
        source: "unhandled-rejection",
        errorMessage: "async task failed",
      }),
    );
  });
});
