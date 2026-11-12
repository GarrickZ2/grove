import { describe, expect, it } from "vitest";
import { anchorOn, anchorOnArea, describePlace, idsAt, placeOf, type SceneElement } from "./sketchAnchor";

const el = (id: string, x: number, y: number, extra: Partial<SceneElement> = {}): SceneElement =>
  ({ id, type: "rectangle", x, y, width: 100, height: 50, ...extra });

const scene: SceneElement[] = [
  el("r1", 0, 0),
  el("t1", 10, 10, { type: "text", text: "Sign in", containerId: "r1" }),
  el("g1", 300, 0, { groupIds: ["grp"] }),
  el("g2", 420, 0, { groupIds: ["grp"], type: "ellipse" }),
];

describe("sketch comment anchors", () => {
  it("puts a label's comment on its shape, with the shape's text", () => {
    const anchor = anchorOn(scene, ["t1"]);
    expect(anchor?.items).toEqual([{ id: "r1", type: "rectangle", text: "Sign in" }]);
    expect(anchor?.box).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("picks a whole group on click, and nothing on empty canvas", () => {
    expect(idsAt(scene, 320, 20, 1).sort()).toEqual(["g1", "g2"]);
    expect(idsAt(scene, 1000, 1000, 1)).toEqual([]);
  });

  it("takes the elements whose middle is inside a dragged area", () => {
    const anchor = anchorOnArea(scene, { x: -10, y: -10, width: 200, height: 100 });
    expect(anchor.area).toBe(true);
    expect(anchor.items?.map((item) => item.id)).toEqual(["r1"]);
    expect(describePlace(anchor)).toBe('the area x=-10 y=-10 w=200 h=100, which holds `r1` (rectangle, "Sign in")');
  });

  it("follows its elements, and is stale once they are gone", () => {
    const anchor = anchorOn(scene, ["g1", "g2"])!;
    const moved = new Map(scene.map((entry) => [entry.id, entry.id === "g1" ? { ...entry, y: 200 } : entry]));
    expect(placeOf(anchor, moved)).toEqual({ box: { x: 300, y: 0, width: 220, height: 250 }, stale: false });
    expect(placeOf(anchor, new Map())).toEqual({ box: anchor.box, stale: true });
  });
});
