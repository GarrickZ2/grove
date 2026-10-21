import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundChatConnections, BACKGROUND_CHAT_IDLE_MS as idle, trackChatSocketSends, watchBackgroundChatConnections } from "./backgroundChatConnections";

describe("background chat connections", () => {
  beforeEach(() => sessionStorage.clear());

  it("protects the observed session and releases a silent background session at ten minutes", () => {
    const connections = new BackgroundChatConnections("test");
    connections.track("visible", 0);
    connections.track("background", 0);
    expect(connections.releaseIdle("visible", idle - 1)).toEqual([]);
    expect(connections.releaseIdle("visible", idle)).toEqual(["background"]);
    expect(connections.canConnect("visible")).toBe(true);
    expect(connections.canConnect("background")).toBe(false);
    // Repeat sweeps cannot re-close or re-activate the session.
    expect(connections.releaseIdle("visible", 2 * idle)).toEqual([]);
  });

  it("releases the selected session when the whole page is hidden, even while its task runs", () => {
    const connections = new BackgroundChatConnections("test");
    connections.track("working", 0);
    expect(connections.releaseIdle("working", idle)).toEqual([]);
    // No cancel/kill is sent: only the frontend transport is released.
    expect(connections.releaseIdle(null, idle)).toEqual(["working"]);
  });

  it("counts outgoing traffic from every socket send path", () => {
    const connections = new BackgroundChatConnections("test");
    connections.track("background", 0);
    const send = vi.fn();
    const socket = { send } as unknown as WebSocket;
    trackChatSocketSends(socket, () => connections.recordActivity("background", idle - 1));
    socket.send(JSON.stringify({ type: "prompt", text: "continue" }));
    expect(send).toHaveBeenCalledOnce();
    expect(connections.releaseIdle(null, idle)).toEqual([]);
    expect(connections.releaseIdle(null, 2 * idle - 1)).toEqual(["background"]);
  });

  it("new business output postpones release, but automatic connection attempts do not", () => {
    const connections = new BackgroundChatConnections("test");
    connections.track("chat", 0);
    connections.recordActivity("chat", idle - 1);
    // Tracking again during recovery must not reset the business clock.
    connections.track("chat", 2 * idle - 2);
    expect(connections.releaseIdle(null, 2 * idle - 2)).toEqual([]);
    expect(connections.releaseIdle(null, 2 * idle - 1)).toEqual(["chat"]);
  });

  it("fences late URL signing and all automatic recovery until the user observes the session", () => {
    const connections = new BackgroundChatConnections("test", sessionStorage);
    connections.track("chat", 0);
    const ticket = connections.ticket();
    connections.releaseIdle(null, idle);
    expect(connections.canFinishConnect("chat", ticket)).toBe(false);
    for (const source of ["retry", "heartbeat", "online", "transport-ready", "rerender"]) {
      expect(connections.canConnect("chat"), source).toBe(false);
    }
    expect(connections.observe("chat")).toBe(true);
    expect(connections.canConnect("chat")).toBe(true);
    expect(connections.observe("chat")).toBe(false);
  });

  it("keeps intentional release across remounts, without affecting other tasks", () => {
    const first = new BackgroundChatConnections("task1", sessionStorage);
    first.track("chat", 0);
    first.releaseIdle(null, idle);
    first.unmount();
    const remounted = new BackgroundChatConnections("task1", sessionStorage);
    expect(remounted.canConnect("chat")).toBe(false);
    expect(new BackgroundChatConnections("task2", sessionStorage).canConnect("chat")).toBe(true);
    remounted.observe("chat");
    expect(new BackgroundChatConnections("task1", sessionStorage).canConnect("chat")).toBe(true);
  });

  it("merges release markers from multiple panels of the same task", () => {
    const first = new BackgroundChatConnections("shared", sessionStorage);
    const second = new BackgroundChatConnections("shared", sessionStorage);
    first.track("a", 0);
    second.track("b", 0);
    first.releaseIdle(null, idle);
    second.releaseIdle(null, idle);
    const remounted = new BackgroundChatConnections("shared", sessionStorage);
    expect(remounted.canConnect("a")).toBe(false);
    expect(remounted.canConnect("b")).toBe(false);
    first.observe("a");
    expect(new BackgroundChatConnections("shared", sessionStorage).canConnect("b")).toBe(false);
  });

  it("does not detach during an unfinished local upload or queue edit", () => {
    const connections = new BackgroundChatConnections("upload-test");
    connections.track("chat", 0);
    expect(connections.releaseIdle(null, idle, () => false)).toEqual([]);
    expect(connections.canConnect("chat")).toBe(true);
    connections.recordActivity("chat", idle);
    expect(connections.releaseIdle(null, idle, () => true)).toEqual([]);
    expect(connections.releaseIdle(null, 2 * idle, () => true)).toEqual(["chat"]);
  });

  it("never finishes a connection from a previous mount after StrictMode remount", () => {
    const connections = new BackgroundChatConnections("test");
    const ticket = connections.ticket();
    connections.unmount();
    expect(connections.canConnect("chat")).toBe(false);
    connections.mount();
    connections.observe("chat");
    expect(connections.canFinishConnect("chat", ticket)).toBe(false);
    expect(connections.canFinishConnect("chat", connections.ticket())).toBe(true);
  });
});

describe("visibility-driven transport lifecycle", () => {
  let stop: (() => void) | undefined;
  let root: HTMLDivElement;
  let visibility: DocumentVisibilityState;
  let panelVisible: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    visibility = "visible";
    panelVisible = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    root = document.createElement("div");
    vi.spyOn(root, "getClientRects").mockImplementation(() => ({ length: panelVisible ? 1 : 0 }) as DOMRectList);
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => ({ width: panelVisible ? 100 : 0, height: panelVisible ? 100 : 0 }) as DOMRect);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a visible reader connected after composer blur, releases in background, resumes only on return", () => {
    const connections = new BackgroundChatConnections("visible-test");
    connections.track("chat", Date.now());
    const release = vi.fn();
    const resume = vi.fn();
    stop = watchBackgroundChatConnections({ connections, root, getActiveChatId: () => "chat", disabled: () => false, onRelease: release, onResume: resume });
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(idle);
    expect(release).not.toHaveBeenCalled();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(release).toHaveBeenCalledWith("chat");
    for (const type of ["online", "grove:transport-ready"]) window.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(idle);
    expect(resume).not.toHaveBeenCalled();
    expect(connections.canConnect("chat")).toBe(false);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("chat");
    expect(connections.canConnect("chat")).toBe(true);
  });

  it("releases a hidden keep-alive panel and restores it when it becomes visible", () => {
    const connections = new BackgroundChatConnections("panel-test");
    connections.track("chat", 0);
    panelVisible = false;
    const release = vi.fn();
    const resume = vi.fn();
    stop = watchBackgroundChatConnections({ connections, root, getActiveChatId: () => "chat", disabled: () => false, onRelease: release, onResume: resume });
    vi.advanceTimersByTime(idle);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("chat");
    panelVisible = true;
    vi.advanceTimersByTime(5000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("chat");
  });

  it("switching back restores the selected session, not other released sessions", () => {
    const connections = new BackgroundChatConnections("switch-test");
    connections.track("first", 0);
    connections.track("second", 0);
    connections.track("third", 0);
    let selected = "first";
    const release = vi.fn();
    const resume = vi.fn();
    stop = watchBackgroundChatConnections({ connections, root, getActiveChatId: () => selected, disabled: () => false, onRelease: release, onResume: resume });
    vi.advanceTimersByTime(idle);
    expect(release.mock.calls.map(([id]) => id)).toEqual(["second", "third"]);
    selected = "second";
    vi.advanceTimersByTime(5000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("second");
    expect(connections.canConnect("third")).toBe(false);
  });
});
