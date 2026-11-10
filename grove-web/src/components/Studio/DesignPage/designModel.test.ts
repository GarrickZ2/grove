import { describe, expect, it } from "vitest";
import type { Design } from "../../../api/designs";
import { boardBounds, fitView, initials, pageComments, parseDesignRef, pinPosition, zoomAt } from "./designModel";

const design: Design = {
  slug: "insight",
  name: "Insight",
  is_system: false,
  has_guide: false,
  warnings: [],
  marks: [],
  labels: [{ text: "Insight", x: 0, y: -150, size: "title" }],
  pages: [
    { file: "a.html", title: "A", x: 0, y: 0, width: 1440, height: 900, rendered_height: 1800, placed: true, version: "1" },
    { file: "b.html", title: "B", x: 1560, y: 0, width: 1440, height: 900, placed: true, version: "1" },
  ],
};

describe("board geometry", () => {
  it("bounds cover artboards at their rendered height, and labels", () => {
    expect(boardBounds(design)).toEqual({ left: 0, top: -150, right: 3000, bottom: 1800 });
    expect(boardBounds({ ...design, pages: [], labels: [] })).toBeNull();
  });

  it("fits the board into the viewport and centres it", () => {
    const view = fitView(boardBounds(design), { width: 1096, height: 800 }, 48);
    expect(view.k).toBeCloseTo(1000 / 3000);
    expect(view.x).toBeCloseTo(48);
    // 1950 world px tall → 650 on screen, centred in 800, shifted for top = -150.
    expect(view.y).toBeCloseTo((800 - 650) / 2 + 150 * view.k);
  });

  it("never zooms in past 100% to fit", () => {
    expect(fitView({ left: 0, top: 0, right: 100, bottom: 100 }, { width: 1000, height: 1000 }).k).toBe(1);
  });

  it("zooms around the pointer", () => {
    const view = zoomAt({ x: 100, y: 50, k: 0.5 }, 2, 300, 250);
    expect(view.k).toBe(1);
    // The board point under the pointer stays under it.
    expect((300 - view.x) / view.k).toBeCloseTo((300 - 100) / 0.5);
    expect((250 - view.y) / view.k).toBeCloseTo((250 - 50) / 0.5);
  });
});

describe("comments", () => {
  const comment = (id: number, page: string, status: "open" | "resolved") => ({
    id, design: "insight", page, anchor: null, author: "Ada", content: "", timestamp: "", status, via_share: false, replies: [],
  });

  it("keeps a page's open comments", () => {
    const all = [comment(1, "a.html", "open"), comment(2, "a.html", "resolved"), comment(3, "b.html", "open")];
    expect(pageComments(all, "insight", "a.html").map((c) => c.id)).toEqual([1]);
    expect(pageComments(all, "insight", "a.html", true).map((c) => c.id)).toEqual([1, 2]);
  });

  it("pins sit on the element, where it is now", () => {
    const anchor = { x: 100, y: 200, width: 300, height: 40 };
    expect(pinPosition(anchor, undefined, { width: 1440 }, 0)).toEqual({ x: 400, y: 200 });
    expect(pinPosition(anchor, { x: 120, y: 260, width: 300, height: 40 }, { width: 1440 }, 0)).toEqual({ x: 420, y: 260 });
    // No element: stacked in the page's corner.
    expect(pinPosition(null, undefined, { width: 1440 }, 1)).toEqual({ x: 1440 - 28 - 34, y: 28 });
  });

  it("initials", () => {
    expect(initials("Ada Byron King")).toBe("AK");
    expect(initials("garrick")).toBe("G");
    expect(initials("  ")).toBe("?");
  });
});

describe("design:// references", () => {
  it("parses a design, a page, and the design system", () => {
    expect(parseDesignRef("design://insight-ui")).toEqual({ design: "insight-ui", page: undefined });
    expect(parseDesignRef("design://insight-ui/overview.html")).toEqual({ design: "insight-ui", page: "overview.html" });
    expect(parseDesignRef("design://system")).toEqual({ design: "system", page: undefined });
  });

  it("rejects anything that is not a plain name", () => {
    expect(parseDesignRef("design://../secrets")).toBeNull();
    expect(parseDesignRef("design://a/b/c.html")).toBeNull();
    expect(parseDesignRef("design://a/notes.md")).toBeNull();
    expect(parseDesignRef("sketch://sketch-1")).toBeNull();
  });
});
