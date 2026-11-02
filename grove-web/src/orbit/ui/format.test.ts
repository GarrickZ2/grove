import { describe, expect, it } from "vitest";
import { agoText, formatClock, formatDateTime, formatDay, relativeText, shortAgo } from "./format";

const now = new Date(2026, 10, 1, 12, 0).getTime();

describe("shortAgo / agoText", () => {
  it("compacts ages", () => {
    expect(shortAgo(now - 20_000, now)).toBe("now");
    expect(shortAgo(now - 4 * 60_000, now)).toBe("4m");
    expect(shortAgo(now - 3 * 3_600_000, now)).toBe("3h");
    expect(shortAgo(now - 50 * 3_600_000, now)).toBe("2d");
  });

  it("rounds down at each unit boundary", () => {
    const base = 10 * 24 * 3600 * 1000;
    expect([0, 59, 60 * 4, 3600 * 3, 3600 * 49].map((seconds) => shortAgo(base - seconds * 1000, base))).toEqual(["now", "now", "4m", "3h", "2d"]);
  });

  it("phrases them", () => {
    expect(agoText(now - 1000, now)).toBe("just now");
    expect(agoText(now - 4 * 60_000, now)).toBe("4m ago");
  });
});

describe("relativeText", () => {
  it("says which way and how far", () => {
    expect(relativeText(now + 30_000, now)).toBe("in <1m");
    expect(relativeText(now - 12 * 60_000, now)).toBe("12m ago");
    expect(relativeText(now + 3 * 3_600_000, now)).toBe("in 3h");
  });

  it("falls back to an English date past a day", () => {
    expect(relativeText(new Date(2026, 9, 26, 9, 5), now)).toBe("Oct 26 09:05");
  });

  it("handles bad input", () => {
    expect(relativeText("not a date", now)).toBe("Unknown");
  });
});

describe("English dates", () => {
  it("formats days in en-US whatever the locale", () => {
    expect(formatDay(new Date(2026, 9, 26), { now })).toBe("Oct 26");
    expect(formatDay(new Date(2025, 0, 3), { now })).toBe("Jan 3, 2025");
    expect(formatDay(Date.UTC(2026, 9, 26, 23), { now, timeZone: "UTC" })).toBe("Oct 26");
  });

  it("uses a 24-hour clock", () => {
    expect(formatClock(new Date(2026, 9, 26, 0, 7))).toBe("00:07");
    expect(formatClock(new Date(2026, 9, 26, 23, 40))).toBe("23:40");
    expect(formatDateTime(new Date(2026, 9, 26, 14, 5))).toBe("Oct 26, 2026, 14:05");
  });
});
