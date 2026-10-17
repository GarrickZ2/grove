import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredPanel, type AuthRequiredState } from "./AuthRequiredPanel";

vi.mock("../TaskDetail/XTerminal", () => ({
  XTerminal: ({ wsUrl, onConnectionError }: { wsUrl: string; onConnectionError: () => void }) => (
    <button data-terminal-url={wsUrl} onClick={onConnectionError}>Simulate connection error</button>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

describe("terminal authentication panel", () => {
  it("opens a terminal only after selecting a terminal method, and provides cancellation and error recovery", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const onLogin = vi.fn();
    const onEnd = vi.fn();
    const state: AuthRequiredState = {
      methods: [{ id: "terminal/id", name: "Terminal sign-in", type: "terminal" }, { id: "oauth", name: "Browser sign-in" }],
      status: "idle",
    };
    const render = async (message: AuthRequiredState) => act(async () => {
      root.render(<AuthRequiredPanel message={message} index={3} projectId="project" taskId="task" chatId="chat" onAuthLogin={onLogin} onTerminalEnd={onEnd} />);
    });
    try {
      await render(state);
      expect(host.querySelector("[data-terminal-url]")).toBeNull();
      await act(async () => (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Terminal sign-in")!).click());
      expect(onLogin).toHaveBeenCalledWith(3, "terminal/id");
      await render({ ...state, status: "in_progress", activeMethodId: "terminal/id" });
      const terminal = host.querySelector<HTMLButtonElement>("[data-terminal-url]")!;
      expect(terminal.dataset.terminalUrl).toContain("/projects/project/tasks/task/chats/chat/auth-terminal/terminal%2Fid");
      await act(async () => terminal.click());
      expect(onEnd).toHaveBeenCalledWith(3, expect.stringContaining("Could not open"));
      await act(async () => (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Cancel sign-in")!).click());
      expect(onEnd).toHaveBeenCalledWith(3);
      await render({ ...state, status: "failed", errorMessage: "Cancelled" });
      expect(host.querySelector("[data-terminal-url]")).toBeNull();
      expect(host.textContent).toContain("Cancelled");
      await render({ ...state, status: "in_progress", activeMethodId: "oauth" });
      expect(host.querySelector("[data-terminal-url]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
