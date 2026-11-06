import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ apiClient: { post } }));

describe("updateView", () => {
  let updateView: typeof import("./viewReporter").updateView;

  beforeEach(async () => {
    vi.useFakeTimers();
    post.mockReset();
    post.mockResolvedValue({});
    vi.resetModules();
    ({ updateView } = await import("./viewReporter"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces changes into one report with a stable surface id", () => {
    updateView({ page: "tasks" });
    updateView({ projectId: "p1", taskId: "t1" });
    vi.advanceTimersByTime(300);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/v1/view");
    expect(body).toMatchObject({ page: "tasks", projectId: "p1", taskId: "t1", client: "web" });
    expect(body.surfaceId).toBeTruthy();

    updateView({ chatId: "c1" });
    vi.advanceTimersByTime(300);
    expect(post.mock.calls[1][1].surfaceId).toBe(body.surfaceId);
  });

  it("does not report a change that changes nothing", () => {
    updateView({ page: "same" });
    vi.advanceTimersByTime(300);
    post.mockClear();
    updateView({ page: "same" });
    vi.advanceTimersByTime(300);
    expect(post).not.toHaveBeenCalled();
  });

  it("sends a heartbeat so a quiet window stays listed", () => {
    updateView({ page: "beat" });
    vi.advanceTimersByTime(300);
    post.mockClear();
    vi.advanceTimersByTime(30_300);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("survives a server without the endpoint", async () => {
    post.mockRejectedValueOnce(new Error("404"));
    updateView({ page: "old-server" });
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
