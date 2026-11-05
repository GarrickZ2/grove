import { describe, expect, it } from "vitest";
import {
  fitOrbitBottom,
  fitOrbitWidths,
  isOrbitPanelOpen,
  migrateToOrbitSlots,
  openOrbitPanel,
  orbitSlotFor,
  terminalPositionOf,
  toggleOrbitPanel,
  ORBIT_BOTTOM_MIN,
  ORBIT_CHAT_MIN,
  ORBIT_DOCK_MAX,
  ORBIT_SIDE_MIN,
  visibilityToPersist,
  withAgentRule,
  type OrbitDockState,
} from "./orbitDock";

const base: OrbitDockState = {
  auxType: null,
  auxVisible: false,
  chatVisible: true,
  infoType: null,
  infoVisible: false,
  bottomVisible: false,
};

describe("orbitSlotFor", () => {
  it("docks the terminal below, the graph and info panels on the right, the rest on the left", () => {
    expect(orbitSlotFor("terminal", "aux")).toBe("bottom");
    expect(orbitSlotFor("graph", "aux")).toBe("dock");
    expect(orbitSlotFor("git", "info")).toBe("dock");
    expect(orbitSlotFor("plugin:x", "info")).toBe("dock");
    expect(orbitSlotFor("review", "aux")).toBe("aux");
    expect(orbitSlotFor("plugin:y", "aux")).toBe("aux");
  });
});

describe("toggleOrbitPanel", () => {
  it("opens a dock panel, switches to another, and closes the one showing", () => {
    const git = toggleOrbitPanel(base, "git", "dock");
    expect(git).toMatchObject({ infoType: "git", infoVisible: true });
    const notes = toggleOrbitPanel(git, "notes", "dock");
    expect(notes).toMatchObject({ infoType: "notes", infoVisible: true });
    expect(toggleOrbitPanel(notes, "notes", "dock")).toMatchObject({ infoType: "notes", infoVisible: false });
  });

  it("docks the terminal on the left when the setting says so", () => {
    expect(orbitSlotFor("terminal", "aux", "left")).toBe("aux");
    expect(terminalPositionOf("left")).toBe("left");
    expect(terminalPositionOf(undefined)).toBe("bottom");
    expect(toggleOrbitPanel({ ...base, auxType: "review", auxVisible: true }, "terminal", "aux"))
      .toMatchObject({ auxType: "terminal", auxVisible: true, bottomVisible: false });
  });

  it("toggles the bottom terminal independently of the other docks", () => {
    const open = toggleOrbitPanel({ ...base, infoType: "git", infoVisible: true }, "terminal", "bottom");
    expect(open).toMatchObject({ bottomVisible: true, infoVisible: true });
    expect(toggleOrbitPanel(open, "terminal", "bottom").bottomVisible).toBe(false);
  });

  it("brings the Agent back when the left panel closes", () => {
    const review = toggleOrbitPanel({ ...base, chatVisible: false }, "review", "aux");
    expect(review).toMatchObject({ auxType: "review", auxVisible: true, chatVisible: false });
    expect(toggleOrbitPanel(review, "review", "aux")).toMatchObject({ auxVisible: false, chatVisible: true });
  });

  it("openOrbitPanel never closes", () => {
    const open = openOrbitPanel(base, "stats", "dock");
    expect(openOrbitPanel(open, "stats", "dock")).toBe(open);
    expect(isOrbitPanelOpen(open, "stats", "dock")).toBe(true);
  });
});

describe("migrateToOrbitSlots", () => {
  it("carries an open terminal over when its position changes", () => {
    expect(migrateToOrbitSlots({ ...base, bottomVisible: true }, "left"))
      .toMatchObject({ auxType: "terminal", auxVisible: true, bottomVisible: false });
    const left = { ...base, auxType: "terminal", auxVisible: true };
    expect(migrateToOrbitSlots(left, "left")).toBe(left);
    expect(migrateToOrbitSlots(left, "bottom"))
      .toMatchObject({ auxType: null, auxVisible: false, bottomVisible: true });
  });

  it("moves an open Workbench terminal to the bottom dock", () => {
    expect(migrateToOrbitSlots({ ...base, auxType: "terminal", auxVisible: true }))
      .toMatchObject({ auxType: null, auxVisible: false, bottomVisible: true });
  });

  it("moves an open graph to the right dock and leaves other panels alone", () => {
    expect(migrateToOrbitSlots({ ...base, auxType: "graph", auxVisible: true, infoType: "git" }))
      .toMatchObject({ auxType: null, infoType: "graph", infoVisible: true });
    const review = { ...base, auxType: "review", auxVisible: true };
    expect(migrateToOrbitSlots(review)).toBe(review);
  });
});

describe("fitOrbitWidths / fitOrbitBottom", () => {
  it("keeps the Agent its minimum width", () => {
    const fit = fitOrbitWidths(1200, { aux: 900, dock: 500 }, { aux: true, dock: true, chat: true });
    expect(fit.dock).toBe(500);
    expect(fit.aux).toBe(1200 - ORBIT_CHAT_MIN - 500);
  });

  it("caps the dock and never goes below the side minimum", () => {
    expect(fitOrbitWidths(3000, { aux: 500, dock: 2000 }, { aux: false, dock: true, chat: true }).dock).toBe(ORBIT_DOCK_MAX);
    expect(fitOrbitWidths(500, { aux: 500, dock: 400 }, { aux: true, dock: true, chat: true }).aux).toBe(ORBIT_SIDE_MIN);
  });

  it("passes sizes through before the shell is measured", () => {
    expect(fitOrbitWidths(0, { aux: 1, dock: 2 }, { aux: true, dock: true, chat: true })).toEqual({ aux: 1, dock: 2 });
    expect(fitOrbitBottom(0, 999)).toBe(999);
  });

  it("bounds the terminal height", () => {
    expect(fitOrbitBottom(800, 50)).toBe(ORBIT_BOTTOM_MIN);
    expect(fitOrbitBottom(800, 700)).toBe(800 - 220);
  });
});

describe("Agent visibility", () => {
  it("keeps the Agent unless a left panel is open", () => {
    expect(withAgentRule({ auxType: null, auxVisible: false, chatVisible: false }).chatVisible).toBe(true);
    expect(withAgentRule({ auxType: "review", auxVisible: false, chatVisible: false }).chatVisible).toBe(true);
    const behindPanel = { auxType: "artifacts", auxVisible: true, chatVisible: false };
    expect(withAgentRule(behindPanel)).toBe(behindPanel);
  });

  it("never saves the automatic narrow-window collapse", () => {
    // Desktop: Agent + Artifacts + Graph dock. Narrowing collapsed to Artifacts only.
    const desktop = { auxType: "artifacts", auxVisible: true, chatVisible: true, infoVisible: true };
    const collapsed = { auxType: "artifacts", auxVisible: true, chatVisible: false, infoVisible: false };
    expect(visibilityToPersist(collapsed, desktop, true, true)).toEqual(desktop);
    expect(visibilityToPersist(collapsed, desktop, true, false)).toEqual(desktop);
  });

  it("saves the user's own desktop choice, with the Agent rule in Orbit only", () => {
    const hidden = { auxType: "artifacts", auxVisible: true, chatVisible: false, infoVisible: false };
    expect(visibilityToPersist(hidden, hidden, false, true)).toEqual(hidden);
    const infoOnly = { auxType: null, auxVisible: false, chatVisible: false, infoVisible: true };
    expect(visibilityToPersist(infoOnly, infoOnly, false, true).chatVisible).toBe(true);
    // Workbench keeps its old rule (Agent may hide next to an info panel).
    expect(visibilityToPersist(infoOnly, infoOnly, false, false).chatVisible).toBe(false);
  });
});
