import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPAND_MS, EXPAND_REDUCED_MS, StarfieldEngine, type Phase } from "./engine";
import { twoCliques } from "./fixtures";
import { buildStarScene } from "./scene";

/** A manual clock + requestAnimationFrame queue. */
function scheduler() {
  let now = 0, id = 0;
  const queue = new Map<number, (t: number) => void>();
  return {
    raf: (cb: (t: number) => void) => { queue.set(++id, cb); return id; },
    caf: (handle: number) => { queue.delete(handle); },
    now: () => now,
    pending: () => queue.size,
    /** Advance the clock and run the frames that were queued. */
    tick(ms = 16) { now += ms; const due = [...queue.values()]; queue.clear(); due.forEach((cb) => cb(now)); },
  };
}
function box(width: number, height: number, left = 0, top = 0) {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
  return el;
}

describe("StarfieldEngine", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("innerHeight", 900);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function setup(motion: { paused?: boolean; reduced?: boolean } = {}) {
    const clock = scheduler();
    const phases: Phase[] = [];
    const focus = vi.fn();
    const engine = new StarfieldEngine({ onPhase: (p) => phases.push(p), onFocus: focus }, clock);
    const scene = buildStarScene(twoCliques().entities, twoCliques().relations);
    engine.setMotion(Boolean(motion.paused), Boolean(motion.reduced));
    engine.attachCard(box(800, 600, 320, 180), document.createElement("canvas"));
    engine.setScene(scene);
    clock.tick();
    const at = (id: string) => { const i = scene.indexById.get(id)!; return [scene.px[i], scene.py[i], i] as const; };
    return { engine, clock, scene, phases, focus, at };
  }

  it("projects every star inside the card", () => {
    const { scene } = setup({ paused: true });
    for (let i = 0; i < scene.n; i++) {
      expect(scene.px[i]).toBeGreaterThan(0); expect(scene.px[i]).toBeLessThan(800);
      expect(scene.py[i]).toBeGreaterThan(0); expect(scene.py[i]).toBeLessThan(600);
    }
  });

  it("click pins a star, clicking it again unpins, clicking empty space unpins", () => {
    const { engine, at } = setup({ paused: true });
    const [x, y, i] = at("a1");
    engine.pointerDown(1, x, y); engine.pointerUp(1, x, y, false);
    expect(engine.pinned).toBe(i);
    engine.pointerDown(1, x, y); engine.pointerUp(1, x, y, false);
    expect(engine.pinned).toBe(-1);
    engine.pin(i);
    engine.pointerDown(1, 2, 2); engine.pointerUp(1, 2, 2, false);
    expect(engine.pinned).toBe(-1);
  });

  it("hover focuses a star without pinning; touch never hovers", () => {
    const { engine, at, focus } = setup({ paused: true });
    const [x, y, i] = at("b1");
    expect(engine.pointerMove(9, x, y, false)).toBe(true);
    expect(focus).toHaveBeenLastCalledWith({ hoverIdx: i, pinIdx: -1, focusIdx: i });
    engine.pointerLeave();
    expect(focus).toHaveBeenLastCalledWith({ hoverIdx: -1, pinIdx: -1, focusIdx: -1 });
    expect(engine.pointerMove(9, x, y, true)).toBe(false);
  });

  it("a drag orbits instead of pinning, and wheel zoom is clamped", () => {
    const { engine, at } = setup({ paused: true });
    const [x, y] = at("a1");
    const yaw = engine.cam.yaw;
    engine.pointerDown(1, x, y);
    engine.pointerMove(1, x + 60, y, false);
    engine.pointerUp(1, x + 60, y, false);
    expect(engine.cam.yaw).toBeGreaterThan(yaw);
    expect(engine.pinned).toBe(-1);
    for (let k = 0; k < 50; k++) engine.wheel(-400);
    expect(engine.cam.zoom).toBeLessThanOrEqual(3.2);
    engine.fitView();
    expect(engine.cam.zoom).toBe(1);
  });

  it("drifts while motion is on and stops scheduling frames when paused or reduced", () => {
    const moving = setup();
    const yaw = moving.engine.cam.yaw;
    moving.clock.tick(); moving.clock.tick();
    expect(moving.engine.cam.yaw).toBeGreaterThan(yaw);
    expect(moving.clock.pending()).toBe(1);

    const still = setup({ reduced: true });
    const before = still.engine.cam.yaw;
    still.clock.tick(); still.clock.tick();
    expect(still.engine.cam.yaw).toBe(before);
    expect(still.clock.pending()).toBe(0);
  });

  it("pauses the loop while the card is offscreen", () => {
    const { engine, clock } = setup();
    engine.setVisible(false);
    clock.tick(); clock.tick();
    expect(clock.pending()).toBe(0);
    engine.setVisible(true);
    expect(clock.pending()).toBe(1);
  });

  it("expands into the night sky over ~600ms and collapses back", () => {
    const { engine, clock, phases } = setup();
    engine.expand();
    expect(engine.phase).toBe("expanding");
    const stage = box(1440, 900), scrim = document.createElement("div");
    engine.attachFull(stage, scrim, document.createElement("canvas"), document.createElement("canvas"));
    clock.tick(EXPAND_MS / 2);
    expect(engine.phase).toBe("expanding");
    expect(stage.style.clipPath).toMatch(/^inset\(/);
    clock.tick(EXPAND_MS);
    expect(engine.phase).toBe("expanded");
    expect(scrim.style.opacity).toBe("0.94");
    engine.collapse();
    expect(engine.phase).toBe("collapsing");
    clock.tick(EXPAND_MS + 16);
    expect(engine.phase).toBe("card");
    expect(phases).toEqual(["expanding", "expanded", "collapsing", "card"]);
  });

  it("uses a short crossfade with no clip growth under reduced motion", () => {
    const { engine, clock } = setup({ reduced: true });
    engine.expand();
    const stage = box(1440, 900);
    engine.attachFull(stage, document.createElement("div"), document.createElement("canvas"), document.createElement("canvas"));
    expect(stage.style.clipPath).toBe("none");
    clock.tick(EXPAND_REDUCED_MS + 1);
    expect(engine.phase).toBe("expanded");
  });

  it("keeps a pin across a scene rebuild when the memory still exists", () => {
    const { engine, at } = setup({ paused: true });
    const [, , i] = at("b2");
    engine.pin(i);
    const data = twoCliques();
    const next = buildStarScene(data.entities.filter((e) => e.entity_id !== "solo"), data.relations);
    engine.setScene(next);
    expect(next.stars[engine.pinned].e.entity_id).toBe("b2");
  });
});
