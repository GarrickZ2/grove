import { describe, expect, it } from "vitest";
import {
  buildComposerStatus, currentPlanStep, formatElapsed, hasComposerStatus, isRiskyMode,
  orbitTrayForPanel, planChip, resolveOrbAction, shortSettingLabel, usageRingModel, type ComposerStatusInput,
} from "./composerStatus";

const base: ComposerStatusInput = {
  running: false, planEntries: [], planDocTitle: null, subagents: [], backgroundCount: 0,
  queue: { count: 0, failed: 0 }, memoryCount: 0, commentCount: 0, ask: null,
};

describe("composer status zone", () => {
  it("shows a background chip while work keeps running and maps its panel to the tray", () => {
    const status = buildComposerStatus({ ...base, backgroundCount: 2 });
    expect(status.background).toBe(2);
    expect(hasComposerStatus(status)).toBe(true);
    expect(orbitTrayForPanel("background")).toBe("background");
  });

  it("shows nothing for an idle session without plan, subagents, queue, memory or comments", () => {
    expect(hasComposerStatus(buildComposerStatus(base))).toBe(false);
    expect(hasComposerStatus(null)).toBe(false);
  });

  it("shows while a turn runs, reading just Working (elapsed lives in the transcript)", () => {
    const status = buildComposerStatus({ ...base, running: true });
    expect(hasComposerStatus(status)).toBe(true);
    expect(status.plan).toEqual({ kind: "working" });
  });

  it("shows each chip only when its count is above zero", () => {
    const status = buildComposerStatus({
      ...base,
      subagents: [{ sessionId: "a", status: "Running" }, { sessionId: "b", status: "Completed" }],
      queue: { count: 2, failed: 1 }, memoryCount: 3, commentCount: 0,
    });
    expect(status.subagents).toEqual({ count: 2, running: 1, avatars: ["a", "b"] });
    expect(status.queue).toEqual({ count: 2, failed: 1 });
    expect(status.memory).toBe(3);
    expect(status.comments).toBeNull();
    expect(hasComposerStatus(status)).toBe(true);
  });

  it("shows for a pending agent request alone", () => {
    expect(hasComposerStatus(buildComposerStatus({ ...base, ask: "permission" }))).toBe(true);
  });
});

describe("plan chip", () => {
  const entries = [
    { content: "Find the row", status: "completed" },
    { content: "Check the dark theme", status: "in_progress" },
    { content: "Verify on phone", status: "pending" },
  ];

  it("names the current step with n/m progress, never a separate step count", () => {
    expect(planChip({ ...base, running: true, planEntries: entries })).toEqual({ kind: "steps", label: "Check the dark theme", done: 1, total: 3, live: true });
  });

  it("falls back to the next unfinished step, then to Plan complete", () => {
    expect(currentPlanStep([{ content: "A", status: "completed" }, { content: "B", status: "pending" }])?.content).toBe("B");
    expect(planChip({ ...base, planEntries: [{ content: "A", status: "completed" }] })).toMatchObject({ label: "Plan complete", done: 1, total: 1, live: false });
  });

  it("uses a plan document's title when there are no steps", () => {
    expect(planChip({ ...base, planDocTitle: "Refactor plan" })).toEqual({ kind: "doc", label: "Refactor plan", live: false });
  });

  it("prefers steps over a document and Working over nothing", () => {
    expect(planChip({ ...base, planEntries: entries, planDocTitle: "Doc" })?.kind).toBe("steps");
    expect(planChip(base)).toBeNull();
  });
});

describe("helpers", () => {
  it("maps TaskChat panels onto Orbit trays", () => {
    expect(orbitTrayForPanel("todo")).toBe("plan");
    expect(orbitTrayForPanel("plan")).toBe("plan");
    expect(orbitTrayForPanel("pending")).toBe("queue");
    expect(orbitTrayForPanel("previewComments")).toBe("comments");
    expect(orbitTrayForPanel("permission")).toBe("ask");
    expect(orbitTrayForPanel("quota")).toBeNull();
    expect(orbitTrayForPanel(null)).toBeNull();
  });

  it("resolves the single send/stop button exactly like the Workbench buttons", () => {
    const state = { editing: false, permissionPending: false, busy: false, hasContent: false, pendingCount: 0 };
    expect(resolveOrbAction(state)).toBe("idle");
    expect(resolveOrbAction({ ...state, hasContent: true })).toBe("send");
    expect(resolveOrbAction({ ...state, busy: true })).toBe("stop");
    expect(resolveOrbAction({ ...state, busy: true, hasContent: true })).toBe("queue");
    expect(resolveOrbAction({ ...state, busy: true, hasContent: true, interrupt: true })).toBe("send");
    expect(resolveOrbAction({ ...state, busy: true, pendingCount: 2 })).toBe("sendNow");
    expect(resolveOrbAction({ ...state, busy: true, permissionPending: true, hasContent: true })).toBe("stop");
    expect(resolveOrbAction({ ...state, permissionPending: true, hasContent: true })).toBe("idle");
    expect(resolveOrbAction({ ...state, editing: true, busy: true })).toBe("save");
  });

  it("tints modes that skip approvals", () => {
    expect(isRiskyMode({ value: "bypassPermissions", label: "Bypass Permissions" })).toBe(true);
    expect(isRiskyMode({ value: "yolo" })).toBe(true);
    expect(isRiskyMode({ value: "default", label: "Default" })).toBe(false);
    expect(isRiskyMode(null)).toBe(false);
  });

  it("fills the usage ring from context, else quota used, warning near the limit", () => {
    expect(usageRingModel(38, 80)).toEqual({ percent: 38, tone: "ok", source: "context" });
    expect(usageRingModel(60, null)).toMatchObject({ tone: "warn" });
    expect(usageRingModel(85, null)).toMatchObject({ tone: "critical" });
    // The worse of context and quota wins.
    expect(usageRingModel(38, 15)).toMatchObject({ percent: 38, tone: "critical" });
    expect(usageRingModel(null, 15)).toEqual({ percent: 85, tone: "critical", source: "quota" });
    expect(usageRingModel(null, null)).toBeNull();
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(72_000)).toBe("1m 12s");
    expect(formatElapsed(3_780_000)).toBe("1h 3m");
  });

  it("shortens chip labels on word boundaries", () => {
    expect(shortSettingLabel("Bypass permissions", "mode")).toBe("Bypass");
    expect(shortSettingLabel("Accept edits", "mode")).toBe("Accept edits");
    expect(shortSettingLabel("Default (recommended)", "model")).toBe("Default");
    expect(shortSettingLabel("Claude Sonnet 4.5", "model")).toBe("Claude Sonnet 4.5");
  });
});
