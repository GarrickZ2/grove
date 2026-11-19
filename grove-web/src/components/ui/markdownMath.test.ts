import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root, RootContent } from "mdast";
import { convertLatexDelimiters, remarkMathRules } from "./markdownMath";

/** The math nodes a line parses to, as `type:value`. */
function math(markdown: string): string[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMathRules);
  const tree = processor.runSync(processor.parse(markdown), markdown) as Root;
  const out: string[] = [];
  const walk = (node: Root | RootContent) => {
    if (node.type === "inlineMath" || node.type === "math") out.push(`${node.type}:${node.value}`);
    if ("children" in node) node.children.forEach(walk);
  };
  walk(tree);
  return out;
}

describe("dollar math rules", () => {
  it("reads $…$ and $$…$$", () => {
    expect(math("Energy $E=mc^2$ here")).toEqual(["inlineMath:E=mc^2"]);
    expect(math("$$\n\\sum_i x_i\n$$")).toEqual(["math:\\sum_i x_i"]);
  });

  it("leaves prices and spaced dollars as text", () => {
    expect(math("It costs $5 and $10 today")).toEqual([]);
    expect(math("From $20,000 to $30,000")).toEqual([]);
    expect(math("a $ x $ b")).toEqual([]);
    expect(math("pay $3.50 now, $4 later")).toEqual([]);
  });

  it("never reads code", () => {
    expect(math("`echo $HOME and $PATH`")).toEqual([]);
    expect(math("```sh\necho $a$b\n```")).toEqual([]);
  });
});

describe("convertLatexDelimiters", () => {
  it("turns \\( \\) into inline and \\[ \\] blocks into display math", () => {
    expect(convertLatexDelimiters("where \\( x + 1 \\) holds")).toBe("where $x + 1$ holds");
    expect(convertLatexDelimiters("\\[\na^2 + b^2\n\\]")).toBe("$$\na^2 + b^2\n$$");
    expect(convertLatexDelimiters("  \\[ a = b \\]")).toBe("  $$a = b$$");
    expect(math(convertLatexDelimiters("so \\(\\alpha\\) and\n\n\\[\n\\beta\n\\]"))).toEqual(["inlineMath:\\alpha", "math:\\beta"]);
  });

  it("keeps escaped brackets inside text and anything in code", () => {
    expect(convertLatexDelimiters("see \\[1\\] above")).toBe("see \\[1\\] above");
    expect(convertLatexDelimiters("`\\(x\\)` stays")).toBe("`\\(x\\)` stays");
    expect(convertLatexDelimiters("```\n\\[\n\\(x\\)\n```")).toBe("```\n\\[\n\\(x\\)\n```");
  });
});

describe("KaTeX stylesheet", () => {
  it("is from the KaTeX that rehype-katex renders with", async () => {
    // The stylesheet's class names change between KaTeX versions; a mismatch
    // leaves `\text{}` subscripts full size.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const fromRehype = createRequire(require.resolve("rehype-katex"));
    const ours = require("katex/package.json").version;
    const theirs = fromRehype("katex/package.json").version;
    expect(ours).toBe(theirs);
  });
});
