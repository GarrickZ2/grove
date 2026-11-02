import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_REVIEW_EVENT, requestOpenReview, takeOpenReviewRequest, type OpenReviewRequest } from "./openReview";

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
});
