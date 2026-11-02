import { describe, expect, it } from "vitest";
import { toTestResult, waveformHeights } from "./useVoiceInputTest";
import { pttKeycaps } from "./voiceFormat";

describe("waveformHeights", () => {
  it("is flat without a signal and scales analyser bins", () => {
    expect(waveformHeights(null, 4)).toEqual([4, 4, 4, 4]);
    expect(waveformHeights(new Uint8Array([0, 255]), 4)).toEqual([4, 4, 34, 34]);
  });
});

describe("toTestResult", () => {
  it("keeps a revision only when it changed the text", () => {
    expect(toTestResult("um fix it", "Fix it.")).toEqual({ raw: "um fix it", revised: "Fix it." });
    expect(toTestResult("Fix it.", " Fix it. ")).toEqual({ raw: "Fix it.", revised: null });
    expect(toTestResult("hello", undefined)).toEqual({ raw: "hello", revised: null });
  });
});

describe("pttKeycaps", () => {
  it("names lone modifiers by side and keeps regular keys", () => {
    expect(pttKeycaps("AltRight")).toEqual(["Right Option"]);
    expect(pttKeycaps("F5")).toEqual(["F5"]);
    expect(pttKeycaps(" ")).toEqual(["Space"]);
  });
});
