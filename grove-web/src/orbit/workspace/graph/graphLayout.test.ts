import { describe, expect, it } from "vitest";
import {
  NODE_H,
  NODE_W,
  bestLayout,
  computeLayers,
  edgeGeometry,
  fitView,
  layoutGraph,
  pickDirection,
  statusMeta,
  zoomAround,
} from "./graphLayout";

const chain = [
  { from: "planner", to: "coder" },
  { from: "coder", to: "reviewer" },
  { from: "planner", to: "reviewer" },
];

describe("graphLayout", () => {
  it("puts each agent one layer below its deepest parent", () => {
    const layers = computeLayers(["planner", "coder", "reviewer", "solo"], chain);
    expect(Object.fromEntries(layers)).toEqual({ planner: 0, coder: 1, reviewer: 2, solo: 0 });
  });

  it("survives a cycle and unknown endpoints", () => {
    const layers = computeLayers(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "ghost" }]);
    expect([...layers.keys()]).toEqual(["a", "b"]);
  });

  it("lays layers top to bottom or left to right without overlap", () => {
    const tb = layoutGraph(["planner", "coder", "reviewer"], chain, "TB");
    expect(tb.positions.get("planner")!.y).toBeLessThan(tb.positions.get("coder")!.y);
    expect(tb.positions.get("coder")!.y).toBeLessThan(tb.positions.get("reviewer")!.y);
    const lr = layoutGraph(["planner", "coder", "reviewer"], chain, "LR");
    expect(lr.positions.get("planner")!.x).toBeLessThan(lr.positions.get("coder")!.x);

    const fan = layoutGraph(["root", "a", "b", "c"], [{ from: "root", to: "a" }, { from: "root", to: "b" }, { from: "root", to: "c" }], "TB");
    const xs = ["a", "b", "c"].map((id) => fan.positions.get(id)!.x).sort((p, q) => p - q);
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(NODE_W);
    expect(fan.positions.get("root")!.x).toBeCloseTo(0);
    expect(fan.bounds.maxY - fan.bounds.minY).toBeGreaterThan(NODE_H);
  });

  it("is deterministic for the same input", () => {
    const a = layoutGraph(["planner", "coder", "reviewer"], chain, "TB");
    const b = layoutGraph(["planner", "coder", "reviewer"], chain, "TB");
    expect([...a.positions]).toEqual([...b.positions]);
  });

  it("draws edges from the source card's edge toward the target", () => {
    const { d, mid } = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 200 }, "TB");
    expect(d.startsWith(`M 0 ${NODE_H / 2} C`)).toBe(true);
    expect(mid.y).toBeGreaterThan(0);
    expect(mid.y).toBeLessThan(200);
  });

  it("fits bounds into the viewport and zooms around a point", () => {
    const view = fitView({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 400, 300);
    expect(view.k).toBeCloseTo(1.1);
    expect(view.x).toBeCloseTo(200);
    expect(view.y).toBeCloseTo(150);
    const tiny = fitView({ minX: 0, minY: 0, maxX: 4000, maxY: 100 }, 400, 300);
    expect(tiny.k).toBe(0.55);

    const zoomed = zoomAround({ x: 0, y: 0, k: 1 }, 2, { x: 100, y: 100 });
    expect(zoomed).toEqual({ k: 2, x: -100, y: -100 });
  });

  it("stacks unconnected agents in a tall, narrow canvas", () => {
    expect(bestLayout(["a", "b", "c"], [], 260, 520).direction).toBe("LR");
    expect(bestLayout(["a", "b", "c"], [], 900, 300).direction).toBe("TB");
    expect(bestLayout(["planner", "coder", "reviewer"], chain, 260, 520).direction).toBe("TB");
  });

  it("chooses direction from the canvas shape and maps live statuses", () => {
    expect(pickDirection(900, 400)).toBe("LR");
    expect(pickDirection(360, 600)).toBe("TB");
    expect(statusMeta("busy")).toMatchObject({ label: "Working", tone: "live", pulse: true });
    expect(statusMeta("permission_required").tone).toBe("waiting");
    expect(statusMeta("disconnected").label).toBe("Not running");
  });
});
