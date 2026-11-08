import { describe, expect, it } from "vitest";
import { describeCommand, fitFrame, isInputMethodKey, keyText, modifierBits, pageSize, textToKeys, toPagePoint } from "./browserInput";
import { isBrowserToolCall } from "../../../api/browser";

describe("fitFrame", () => {
  it("letterboxes a frame wider than its container", () => {
    expect(fitFrame({ width: 800, height: 800 }, { width: 1600, height: 800 })).toEqual({
      left: 0,
      top: 200,
      width: 800,
      height: 400,
    });
  });

  it("fills the container until a frame arrives", () => {
    expect(fitFrame({ width: 300, height: 200 }, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 300,
      height: 200,
    });
  });
});

describe("toPagePoint", () => {
  const box = { left: 0, top: 200, width: 800, height: 400 };
  const viewport = { width: 1600, height: 800 };

  it("maps through the frame's scale", () => {
    expect(toPagePoint(400, 400, box, viewport)).toEqual({ x: 800, y: 400 });
  });

  it("ignores the letterbox", () => {
    expect(toPagePoint(400, 100, box, viewport)).toBeNull();
  });
});

describe("pageSize", () => {
  it("takes the height from the frame, not a reported viewport", () => {
    expect(pageSize(1280, { width: 1280, height: 577 })).toEqual({ width: 1280, height: 577 });
  });

  it("scales a frame narrower than the page", () => {
    expect(pageSize(1600, { width: 800, height: 400 })).toEqual({ width: 1600, height: 800 });
  });
});

describe("keyboard", () => {
  const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("encodes modifiers as the driver expects", () => {
    expect(modifierBits(plain)).toBe(0);
    expect(modifierBits({ ...plain, ctrlKey: true, shiftKey: true })).toBe(10);
  });

  it("types printable keys and Enter, not shortcuts or named keys", () => {
    expect(keyText({ ...plain, key: "a" })).toBe("a");
    expect(keyText({ ...plain, key: "Enter" })).toBe("\r");
    expect(keyText({ ...plain, key: "Tab" })).toBeUndefined();
    expect(keyText({ ...plain, key: "a", metaKey: true })).toBeUndefined();
  });
});

describe("isInputMethodKey", () => {
  it("catches the Enter that confirms a composition after it ended", () => {
    expect(isInputMethodKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isInputMethodKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("leaves an ordinary Enter alone", () => {
    expect(isInputMethodKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("textToKeys", () => {
  it("sends one character per key event", () => {
    expect(textToKeys("粘贴内容")).toEqual(["粘", "贴", "内", "容"]);
  });

  it("keeps emoji whole and turns newlines into Enter", () => {
    expect(textToKeys("a😀\r\nb\n")).toEqual(["a", "😀", "\r", "b", "\r"]);
  });
});

describe("describeCommand", () => {
  it("names what was acted on but never what was typed", () => {
    expect(describeCommand("fill", { selector: "#password", text: "secret" })).toBe("fill #password");
    expect(describeCommand("navigate", { url: "https://example.com" })).toBe("navigate https://example.com");
    expect(describeCommand("snapshot", {})).toBe("snapshot");
  });
});

describe("isBrowserToolCall", () => {
  it("recognizes the browser tool but not its help", () => {
    expect(isBrowserToolCall("mcp.grove_agent.browser")).toBe(true);
    expect(isBrowserToolCall("mcp__grove_agent__browser")).toBe(true);
    expect(isBrowserToolCall("mcp.grove_agent.browser_help")).toBe(false);
    expect(isBrowserToolCall("Read file")).toBe(false);
    expect(isBrowserToolCall(undefined)).toBe(false);
  });
});
