import { describe, expect, it } from "vitest";
import { isStalePermissionError, looksLikeMarkdownDocument, permissionLayout, permissionOutcome, resolveStalePermission, stalePermissionId } from "./permissionCard";

const option = (option_id: string, kind: string, name = option_id) => ({ option_id, kind, name });

describe("permission card", () => {
  it("reads the outcome of a resolved request", () => {
    expect(permissionOutcome("Allow once")).toBe("allowed");
    expect(permissionOutcome("Yes, and auto-accept edits")).toBe("allowed");
    expect(permissionOutcome("Reject")).toBe("denied");
    expect(permissionOutcome("cancelled")).toBe("cancelled");
  });

  it("groups options and stacks long or unusual sets", () => {
    const row = permissionLayout([option("once", "allow_once"), option("always", "allow_always"), option("no", "reject_once")]);
    expect(row.allow.map((o) => o.option_id)).toEqual(["once", "always"]);
    expect(row.reject.map((o) => o.option_id)).toEqual(["no"]);
    expect(row.stacked).toBe(false);
    expect(permissionLayout([option("a", "allow_once", "Yes, and manually approve edits"), option("b", "reject_once")]).stacked).toBe(true);
    expect(permissionLayout([option("a", "allow_once"), option("m", "switch")]).stacked).toBe(true);
  });

  it("recognizes a Markdown plan but not a command", () => {
    expect(looksLikeMarkdownDocument("# Plan\n\n- Step one\n- Step two")).toBe(true);
    expect(looksLikeMarkdownDocument("rm -rf build")).toBe(false);
    expect(looksLikeMarkdownDocument("# comment\necho hi\necho there")).toBe(false);
  });
});

describe("stale permission errors", () => {
  type Msg = { type: string; id?: string; resolved?: string };
  const first: Msg = { type: "permission", id: "read_notes", resolved: "Yes" };
  const second: Msg = { type: "permission", id: "memory_recall" };

  it("recognizes both backend phrasings and names the stale request", () => {
    expect(isStalePermissionError("Permission request read_notes is no longer pending")).toBe(true);
    expect(isStalePermissionError("No pending permission request")).toBe(true);
    expect(isStalePermissionError("Agent crashed")).toBe(false);
    expect(stalePermissionId("Permission request read_notes is no longer pending", "other")).toBe("read_notes");
    expect(stalePermissionId("No pending permission request", "read_notes")).toBe("read_notes");
    expect(stalePermissionId("No pending permission request", undefined)).toBe("");
  });

  it("never cancels a newer request the backend is waiting on", () => {
    // A second click on the first request arrives after the second request.
    const messages = [first, second];
    expect(resolveStalePermission(messages, "read_notes")).toBe(messages);
    expect(resolveStalePermission(messages, "memory_recall")[1]).toEqual({ ...second, resolved: "Cancelled" });
  });

  it("settles only id-less legacy requests when no id is known", () => {
    const legacy: Msg = { type: "permission", id: "" };
    expect(resolveStalePermission([legacy, second], "")).toEqual([{ ...legacy, resolved: "Cancelled" }, second]);
  });
});
