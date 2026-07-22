import { describe, expect, it } from "vitest";
import { normalizeStrongEmphasis } from "./markdownPreprocess";

describe("normalizeStrongEmphasis", () => {
  it("moves whitespace outside a closing strong delimiter", () => {
    expect(normalizeStrongEmphasis("**解法： **将领域 SOP 工具化")).toBe(
      "**解法：** 将领域 SOP 工具化",
    );
  });

  it("removes whitespace inside an opening strong delimiter", () => {
    expect(normalizeStrongEmphasis("** 服务采用：**诊断机器人")).toBe(
      "<strong>服务采用：</strong>诊断机器人",
    );
  });

  it("does not rewrite inline or fenced code", () => {
    const markdown = "`**解法： **`\n```md\n**解法： **\n```";
    expect(normalizeStrongEmphasis(markdown)).toBe(markdown);
  });

  it("repairs strong emphasis ending in full-width punctuation before Chinese text", () => {
    expect(normalizeStrongEmphasis("**商家上下文分散：**集成方案")).toBe(
      "<strong>商家上下文分散：</strong>集成方案",
    );
  });
});
