import { describe, expect, it } from "vitest";
import { dropSpot, type DropZones } from "./useToolDrag";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
const closed: DropZones = {
  bar: [{ key: "a", rect: rect(100, 10, 60, 24) }, { key: "b", rect: rect(162, 10, 60, 24) }],
  strip: rect(20, 7, 280, 30),
  moreButton: rect(232, 10, 60, 24),
  menu: [],
  menuBox: null,
};
const open: DropZones = {
  ...closed,
  // Its first row, at 60, is a panel of the strip's that doesn't fit.
  menu: [{ key: "c", rect: rect(100, 90, 200, 30) }, { key: "d", rect: rect(100, 120, 200, 30) }],
  menuBox: rect(95, 55, 210, 100),
};
const spot = (x: number, y: number, zones: DropZones = open) => {
  const found = dropSpot({ x, y }, zones);
  return found && `${found.side} ${found.target}${found.onStrip ? " strip" : ""}`;
};

describe("where a dragged panel lands", () => {
  it("goes beside the panel under the pointer", () => {
    expect(spot(105, 20)).toBe("before a strip");
    expect(spot(170, 20)).toBe("before b strip");
    expect(spot(220, 20)).toBe("after b strip");
    expect(spot(150, 115)).toBe("before d");
    expect(spot(150, 148)).toBe("after d");
  });

  it("goes under More from its button, and above More's own panels", () => {
    expect(spot(260, 20)).toBe("after more");
    expect(spot(150, 62)).toBe("before c");
    expect(spot(150, 62, { ...open, menu: [] })).toBe("after more");
  });

  it("goes onto an empty strip", () => {
    expect(spot(60, 20, { ...closed, bar: [] })).toBe("before more strip");
  });

  it("goes nowhere away from both", () => {
    expect(spot(150, 400)).toBeNull();
    expect(spot(700, 20, closed)).toBeNull();
  });
});
