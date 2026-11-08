import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideApproval, getPendingApprovals } from "../../../../api/browser";
import { SessionApprovalRequest } from "./SessionApprovalRequest";

vi.mock("../../../../api/browser", () => ({
  getPendingApprovals: vi.fn(),
  decideApproval: vi.fn(() => Promise.resolve([])),
}));

describe("SessionApprovalRequest", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const show = async (pending: { chatId: string; capability: string }[], chatId = "chat-a") => {
    vi.mocked(getPendingApprovals).mockResolvedValue(pending as never);
    await act(async () => root.render(<SessionApprovalRequest projectId="p" taskId="t" chatId={chatId} />));
  };

  it("stays out of the way until this session is waiting", async () => {
    await show([]);
    expect(host.textContent).toBe("");
    await show([{ chatId: "chat-b", capability: "computer" }]);
    expect(host.textContent).toBe("");
  });

  it("asks about the computer in the session that wants it", async () => {
    await show([{ chatId: "chat-a", capability: "computer" }]);
    expect(host.textContent).toContain("Use your computer?");
    const allow = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Allow"));
    await act(async () => allow?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(decideApproval).toHaveBeenCalledWith("p", "t", { chatId: "chat-a", capability: "computer", allow: true });
    expect(host.textContent).toBe("");
  });

  it("asks about the browser too", async () => {
    await show([{ chatId: "chat-a", capability: "personal_browser" }]);
    expect(host.textContent).toContain("act as you");
  });
});
