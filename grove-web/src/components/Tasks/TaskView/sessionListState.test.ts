import { describe, expect, it } from "vitest";
import {
  preserveActiveSessionInRefresh,
  promoteSession,
  resolveRestoredBusy,
  resolveRestoredMessages,
} from "./sessionListState";

describe("session list state", () => {
  const a = { id: "A", title: "A" };
  const b = { id: "B", title: "B" };

  it("promotes the sending session immediately without changing its identity", () => {
    const promoted = promoteSession([a, b], "B");
    expect(promoted).toEqual([b, a]);
    expect(promoted[0]).toBe(b);
  });

  it("does not disturb the list for an unknown or already-first session", () => {
    expect(promoteSession([a, b], "A")).toEqual([a, b]);
    expect(promoteSession([a, b], "missing")).toEqual([a, b]);
  });

  it("promotes a session only to the top of its pinned or unpinned group", () => {
    const p1 = { id: "P1", title: "P1", pinned: true };
    const p2 = { id: "P2", title: "P2", pinned: true };
    expect(promoteSession([p1, p2, a, b], "B")).toEqual([p1, p2, b, a]);
    expect(promoteSession([p1, p2, a, b], "P2")).toEqual([p2, p1, a, b]);
  });

  it("keeps a missing unpinned active session below the pinned ones", () => {
    const p1 = { id: "P1", title: "P1", pinned: true };
    expect(preserveActiveSessionInRefresh([p1, a], "B", b, false)).toEqual([p1, b, a]);
  });

  it("allows recency ordering to change without replacing the active session", () => {
    expect(preserveActiveSessionInRefresh([b, a], "B", b, false)).toEqual([
      b,
      a,
    ]);
  });

  it("keeps a live active session through a transiently incomplete refresh", () => {
    expect(preserveActiveSessionInRefresh([a], "B", b, false)).toEqual([b, a]);
  });

  it("does not restore an archived session into the active list", () => {
    expect(preserveActiveSessionInRefresh([a], "B", b, true)).toEqual([a]);
  });

  it("prefers live runtime busy state over a stale switch snapshot", () => {
    expect(resolveRestoredBusy(true, false)).toBe(true);
    expect(resolveRestoredBusy(false, true)).toBe(false);
    expect(resolveRestoredBusy(undefined, true)).toBe(true);
  });

  it("never replaces a live transcript with a stale switch snapshot", () => {
    const runtime = ["old turn", "current turn"];
    const staleCache = ["current turn"];
    expect(resolveRestoredMessages(runtime, staleCache)).toBe(runtime);
    expect(resolveRestoredMessages(undefined, staleCache)).toBe(staleCache);
    expect(resolveRestoredMessages(undefined, undefined)).toEqual([]);
  });
});
