import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCatalogReader, invalidateAgentCatalog, subscribeAgentCatalog } from "./agentCatalogChanges";

afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe("Agent catalog consistency", () => {
  it("coalesces concurrent readers and replaces an in-flight pre-uninstall response", async () => {
    vi.useFakeTimers();
    let finishOld!: (value: string[]) => void;
    const fetchSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(["claude"]);
    const read = agentCatalogReader<string[]>(fetchSnapshot);
    const first = read();
    expect(read()).toBe(first);
    invalidateAgentCatalog();
    const fresh = read();
    finishOld(["claude", "copilot"]);
    expect(await first).toEqual(["claude"]);
    expect(await fresh).toEqual(["claude"]);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retries an obsolete failure without hiding the fresh catalog", async () => {
    vi.useFakeTimers();
    let failOld!: (error: Error) => void;
    const fetchSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>((_, reject) => { failOld = reject; }))
      .mockResolvedValueOnce(["codex"]);
    const read = agentCatalogReader<string[]>(fetchSnapshot);
    const first = read();
    invalidateAgentCatalog();
    failOld(new Error("old request failed"));
    expect(await first).toEqual(["codex"]);
  });

  it("coalesces mutation bursts for all subscribers and refreshes on window return", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeAgentCatalog(first);
    const unsubscribeSecond = subscribeAgentCatalog(second);
    invalidateAgentCatalog();
    invalidateAgentCatalog();
    vi.advanceTimersByTime(50);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(50);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
    unsubscribeSecond();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(50);
    expect(first).toHaveBeenCalledTimes(2);
  });
});
