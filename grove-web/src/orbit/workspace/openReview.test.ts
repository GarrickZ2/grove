import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_REVIEW_EVENT, requestOpenReview, takeOpenReviewRequest, useOpenReviewRequests, type OpenReviewRequest } from "./openReview";

function Host({ ready, onOpen }: { ready: boolean; onOpen: (r: OpenReviewRequest) => void }) {
  useOpenReviewRequests("p", "t", ready, onOpen);
  return null;
}

describe("openReview", () => {
  afterEach(() => {
    vi.useRealTimers();
    takeOpenReviewRequest("p", "t"); // drain
  });

  it("announces the request and hands it to the matching task once", () => {
    const seen: OpenReviewRequest[] = [];
    const onEvent = (e: Event) => seen.push((e as CustomEvent<OpenReviewRequest>).detail);
    window.addEventListener(OPEN_REVIEW_EVENT, onEvent);
    requestOpenReview({ projectId: "p", taskId: "t", file: "src/a.ts", line: 4, mode: "diff" });
    window.removeEventListener(OPEN_REVIEW_EVENT, onEvent);

    expect(seen).toEqual([{ projectId: "p", taskId: "t", file: "src/a.ts", line: 4, mode: "diff" }]);
    expect(takeOpenReviewRequest("p", "other")).toBeNull();
    expect(takeOpenReviewRequest("q", "t")).toBeNull();
    expect(takeOpenReviewRequest("p", "t")).toMatchObject({ file: "src/a.ts", line: 4 });
    expect(takeOpenReviewRequest("p", "t")).toBeNull();
  });

  it("drops a request nobody picked up in time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    requestOpenReview({ projectId: "p", taskId: "t" });
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    expect(takeOpenReviewRequest("p", "t")).toBeNull();
  });

  it("keeps a request pending until the workspace knows it has a Review", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onOpen = vi.fn();
    const root = createRoot(document.createElement("div"));
    requestOpenReview({ projectId: "p", taskId: "t", file: "a.ts" });
    await act(async () => root.render(createElement(Host, { ready: false, onOpen })));
    expect(onOpen).not.toHaveBeenCalled();
    // Linked Projects loaded: the deferred request is applied once.
    await act(async () => root.render(createElement(Host, { ready: true, onOpen })));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ file: "a.ts" });
    // A later request reaches a ready workspace through the event.
    await act(async () => requestOpenReview({ projectId: "p", taskId: "t" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
});
