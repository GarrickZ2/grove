import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
  it("leaves only the visible text of a zsh prompt", () => {
    const prompt = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m\n\n\x1b[0m\x1b[27m\x1b[24m\x1b[Jn251-239-138% \x1b[K\x1b[?2004h";
    expect(stripAnsi(prompt)).toBe("%\n\nn251-239-138% ");
  });
});
