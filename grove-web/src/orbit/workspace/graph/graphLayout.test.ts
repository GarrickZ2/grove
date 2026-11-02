import { describe, expect, it } from "vitest";
import {
  METRICS,
  chooseLayout,
  computeLayers,
  edgeGeometry,
  fitView,
  graphSummary,
  keepsLabel,
  layoutGraph,
  nodeDisplayStatus,
  showsEdgeLabel,
  statusMeta,
  statusRing,
  zoomAround,
  type Point,
} from "./graphLayout";

const chain = [
  { from: "planner", to: "coder" },
  { from: "coder", to: "reviewer" },
  { from: "planner", to: "reviewer" },
];
const WIDE = { width: 840, height: 740, compact: false };
const DOCK = { width: 358, height: 740, compact: false };

const ids = (n: number, prefix = "a") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
/** The board's "8 delegating" team. */
const TEAM_IDS = ["lead", "be", "fe", "dba", "qe", "a11y", "tw", "tr"];
const TEAM = [
  { from: "lead", to: "be" }, { from: "lead", to: "fe" }, { from: "be", to: "dba" }, { from: "be", to: "qe" },
  { from: "fe", to: "a11y" }, { from: "fe", to: "tw" }, { from: "tw", to: "tr" },
];

function noOverlap(points: Point[], minDist: number) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThanOrEqual(minDist);
    }
  }
}

describe("graphLayout", () => {
  it("puts each agent one row below its deepest parent", () => {
    const layers = computeLayers(["planner", "coder", "reviewer", "solo"], chain);
    expect(Object.fromEntries(layers)).toEqual({ planner: 0, coder: 1, reviewer: 2, solo: 0 });
  });

  it("survives a cycle and unknown endpoints", () => {
    const layers = computeLayers(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "ghost" }]);
    expect([...layers.keys()]).toEqual(["a", "b"]);
  });

  it("lays delegations out as a tree, children under their parent", () => {
    const { positions } = layoutGraph(TEAM_IDS, TEAM, WIDE);
    const p = (id: string) => positions.get(id)!;
    expect(p("lead").y).toBeLessThan(p("be").y);
    expect(p("be").y).toBe(p("fe").y);
    expect(p("be").y).toBeLessThan(p("qe").y);
    expect(p("tw").y).toBeLessThan(p("tr").y);
    // Backend's children sit left of Frontend's, around their parent.
    expect(p("be").x).toBeLessThan(p("fe").x);
    expect(Math.max(p("dba").x, p("qe").x)).toBeLessThan(Math.min(p("a11y").x, p("tw").x));
    expect(p("lead").x).toBeCloseTo((p("be").x + p("fe").x) / 2, -1);
    noOverlap([...positions.values()], METRICS.regular.slotMin);
  });

  it("is deterministic: same graph, same panel, same positions", () => {
    const a = layoutGraph(TEAM_IDS, TEAM, WIDE);
    const b = layoutGraph([...TEAM_IDS], TEAM.map((e) => ({ ...e })), WIDE);
    expect([...a.positions]).toEqual([...b.positions]);
    expect([...a.positions.keys()]).toEqual(TEAM_IDS);
  });

  it("spreads out to use a larger panel", () => {
    const small = layoutGraph(["planner", "coder", "reviewer"], chain, { width: 400, height: 400, compact: false });
    const big = layoutGraph(["planner", "coder", "reviewer"], chain, { width: 1200, height: 900, compact: false });
    const span = (l: typeof small) => l.bounds.maxY - l.bounds.minY;
    expect(span(big)).toBeGreaterThan(span(small));
  });

  it("puts agents without delegations in a grid: 4 across when wide, 2 in a dock", () => {
    const cols = (l: ReturnType<typeof layoutGraph>) => new Set([...l.positions.values()].map((p) => p.x)).size;
    const rows = (l: ReturnType<typeof layoutGraph>) => new Set([...l.positions.values()].map((p) => p.y)).size;
    const wide = layoutGraph(ids(8), [], WIDE);
    expect(cols(wide)).toBe(4);
    expect(rows(wide)).toBe(2);
    const dock = layoutGraph(ids(8), [], DOCK);
    expect(cols(dock)).toBe(2);
    expect(rows(dock)).toBe(4);
    // Reading order: left to right, then down.
    const [a0, a1, a2] = ["a0", "a1", "a2"].map((id) => dock.positions.get(id)!);
    expect(a0.y).toBe(a1.y);
    expect(a0.x).toBeLessThan(a1.x);
    expect(a2.y).toBeGreaterThan(a0.y);
    expect(a2.x).toBe(a0.x);
  });

  it("puts loose agents in a grid below the tree", () => {
    const { positions } = layoutGraph(["planner", "coder", "reviewer", "x", "y"], chain, WIDE);
    const treeBottom = Math.max(...["planner", "coder", "reviewer"].map((id) => positions.get(id)!.y));
    expect(positions.get("x")!.y).toBeGreaterThan(treeBottom);
    expect(positions.get("x")!.y).toBe(positions.get("y")!.y);
  });

  it("wraps a row wider than a dock and shrinks the nodes there", () => {
    const regular = layoutGraph(TEAM_IDS, TEAM, DOCK);
    expect(regular.wrapped).toBe(true);
    const dock = chooseLayout(TEAM_IDS, TEAM, 358, 740);
    expect(dock.compact).toBe(true);
    noOverlap([...dock.layout.positions.values()], METRICS.compact.slotMin);
    // Wide panels keep regular nodes; a dock with a small graph does too.
    expect(chooseLayout(TEAM_IDS, TEAM, 840, 740).compact).toBe(false);
    expect(chooseLayout(["planner", "coder", "reviewer"], chain, 358, 740).compact).toBe(false);
    expect(chooseLayout(ids(8), [], 358, 740).compact).toBe(false);
    // Fifteen loose agents are taller than the dock: they shrink.
    expect(chooseLayout(ids(15), [], 358, 600).compact).toBe(true);
  });

  it("draws a curved arrow between the circles' edges, with the label at the middle", () => {
    const { d, label } = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 200 }, 22);
    expect(d.startsWith("M 0 28 Q")).toBe(true);
    expect(d.endsWith(" 0 169")).toBe(true);
    expect(label.y).toBeGreaterThan(0);
    expect(label.y).toBeLessThan(200);
    // Bent sideways, not a straight line.
    expect(label.x).not.toBe(0);
  });

  it("fits bounds into the viewport and zooms around a point", () => {
    const view = fitView({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 400, 300);
    expect(view.k).toBe(1);
    expect(view.x).toBeCloseTo(200);
    expect(view.y).toBeCloseTo(150);
    const tiny = fitView({ minX: 0, minY: 0, maxX: 4000, maxY: 100 }, 400, 300);
    expect(tiny.k).toBe(0.5);

    const zoomed = zoomAround({ x: 0, y: 0, k: 1 }, 2, { x: 100, y: 100 });
    expect(zoomed).toEqual({ k: 2, x: -100, y: -100 });
  });

  it("maps live statuses to the ring and label", () => {
    expect(statusMeta("busy")).toMatchObject({ label: "Working", tone: "live", pulse: true });
    expect(statusMeta("permission_required")).toMatchObject({ label: "Needs you", detail: "Needs permission", tone: "waiting" });
    expect(statusMeta("disconnected").label).toBe("Not running");
    expect(statusRing("busy")).toBe("work");
    expect(statusRing("permission_required")).toBe("ask");
    expect(statusRing("disconnected")).toBe("off");
    expect(statusRing("idle")).toBe("ready");
    expect(statusRing("error")).toBe("err");
    expect(statusRing("done")).toBe("done");
  });

  it("shows an idle agent's settled outcome without pulsing", () => {
    expect(statusMeta("error")).toMatchObject({ label: "Error", tone: "fail", pulse: false });
    expect(statusMeta("done")).toMatchObject({ label: "Done", tone: "ok", pulse: false });

    expect(nodeDisplayStatus("idle", "error")).toBe("error");
    expect(nodeDisplayStatus("idle", "done")).toBe("done");
    expect(nodeDisplayStatus("idle", undefined)).toBe("idle");
    // The live status wins while the agent works, asks or is offline.
    expect(nodeDisplayStatus("busy", "error")).toBe("busy");
    expect(nodeDisplayStatus("permission_required", "done")).toBe("permission_required");
    expect(nodeDisplayStatus("disconnected", "error")).toBe("disconnected");
    // A message still waiting for its reply means it is not done; an error still shows.
    expect(nodeDisplayStatus("idle", "done", true)).toBe("idle");
    expect(nodeDisplayStatus("idle", "error", true)).toBe("error");

    expect(keepsLabel("err", true, false)).toBe(true);
    expect(keepsLabel("done", true, false)).toBe(false);
  });

  it("counts errors and finished agents in the summary", () => {
    const node = (chat_id: string) => ({ chat_id, name: chat_id, agent: "claude", status: "idle", pending_in: 0, pending_out: 0, pending_messages: [] });
    const statuses: Record<string, "busy" | "error" | "done"> = { a: "busy", b: "error", c: "done", d: "done" };
    expect(graphSummary(["a", "b", "c", "d"].map(node), (id) => statuses[id], 1)).toBe("4 agents · 1 working · 1 error · 2 done · 1 queued");
  });

  it("keeps names and task pills only where they matter in a crowded dock", () => {
    expect(keepsLabel("ready", false, false)).toBe(true);
    expect(keepsLabel("ready", true, false)).toBe(false);
    expect(keepsLabel("off", true, true)).toBe(true);
    expect(keepsLabel("work", true, false)).toBe(true);
    expect(keepsLabel("ask", true, false)).toBe(true);

    expect(showsEdgeLabel("idle", { compact: false, dense: false, hot: false })).toBe(true);
    expect(showsEdgeLabel("idle", { compact: false, dense: true, hot: false })).toBe(false);
    expect(showsEdgeLabel("blocked", { compact: false, dense: true, hot: false })).toBe(true);
    expect(showsEdgeLabel("blocked", { compact: true, dense: false, hot: false })).toBe(false);
    expect(showsEdgeLabel("in_flight", { compact: true, dense: false, hot: false })).toBe(true);
    expect(showsEdgeLabel("in_flight", { compact: true, dense: true, hot: false })).toBe(false);
    expect(showsEdgeLabel("idle", { compact: true, dense: true, hot: true })).toBe(true);
  });
});
