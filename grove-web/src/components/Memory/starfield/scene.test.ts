import { describe, expect, it } from "vitest";
import { entity, relation, twoCliques } from "./fixtures";
import { buildStarScene } from "./scene";

describe("buildStarScene", () => {
  it("is deterministic and independent of input order", () => {
    const { entities, relations } = twoCliques();
    const first = buildStarScene(entities, relations);
    const second = buildStarScene([...entities].reverse(), [...relations].reverse());
    expect(Array.from(second.P)).toEqual(Array.from(first.P));
    expect(second.stars.map((s) => s.e.entity_id)).toEqual(first.stars.map((s) => s.e.entity_id));
    expect(second.stars.map((s) => s.comm)).toEqual(first.stars.map((s) => s.comm));
    expect(first.P.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("finds one constellation per clique and folds the loner in as a stray", () => {
    const { entities, relations } = twoCliques();
    const scene = buildStarScene(entities, relations);
    const commOf = (id: string) => scene.stars[scene.indexById.get(id)!].comm;
    expect(new Set(["a1", "a2", "a3", "a4", "a5"].map(commOf)).size).toBe(1);
    expect(new Set(["b1", "b2", "b3", "b4", "b5"].map(commOf)).size).toBe(1);
    expect(commOf("a1")).not.toBe(commOf("b1"));
    expect(scene.clusters.filter((c) => !c.stray)).toHaveLength(2);
    expect(scene.clusters[commOf("solo")].stray).toBe(true);
    // Constellations take different hues and are named by their dominant tag.
    expect(scene.clusters[commOf("a1")].inlStr.light).not.toBe(scene.clusters[commOf("b1")].inlStr.light);
    expect(scene.clusters[commOf("a1")].name).toBe("investing");
  });

  it("keeps clique members closer together than to the other clique", () => {
    const { entities, relations } = twoCliques();
    const scene = buildStarScene(entities, relations);
    const pos = (id: string) => { const i = scene.indexById.get(id)!; return [scene.P[i * 3], scene.P[i * 3 + 1], scene.P[i * 3 + 2]]; };
    const dist = (x: string, y: string) => Math.hypot(...pos(x).map((v, k) => v - pos(y)[k]));
    expect(dist("a1", "a2")).toBeLessThan(dist("a1", "b1"));
    expect(dist("b2", "b3")).toBeLessThan(dist("b2", "a3"));
  });

  it("maps score to magnitude and keeps the label set small", () => {
    const { entities, relations } = twoCliques();
    const scene = buildStarScene(entities, relations);
    const star = (id: string) => scene.stars[scene.indexById.get(id)!];
    expect(star("a1").m).toBeGreaterThan(star("a5").m);
    expect(star("a1").r).toBeGreaterThan(star("solo").r);
    expect(scene.labelSet.size).toBeGreaterThan(0);
    expect(scene.labelSet.size).toBeLessThanOrEqual(8);
    expect(scene.labelSet.has(scene.indexById.get("a1")!)).toBe(true);
  });

  it("offers glimmer slots round-robin across constellations", () => {
    const { entities, relations } = twoCliques();
    const scene = buildStarScene(entities, relations);
    expect(scene.glimmers).toHaveLength(12);
    expect(scene.glimmers[0].comm).not.toBe(scene.glimmers[1].comm);
  });

  it("drops self-links, duplicates and relations to unknown memories", () => {
    const scene = buildStarScene([entity("x", 50), entity("y", 40)], [
      relation("r1", "x", "y"), relation("r2", "y", "x"), relation("r3", "x", "x"), relation("r4", "x", "ghost"),
    ]);
    expect(scene.links).toHaveLength(1);
    expect(scene.nodes[scene.indexById.get("x")!].deg).toBe(1);
  });
});
