import { describe, expect, it } from "vitest";
import { applyEdits, length, px, setCssVariable, setPageVariable, toHex } from "./designEdit";

const PAGE = `<!doctype html>
<html><head><title>T</title></head><body>
<div class="bar"><button id="go" class="btn primary">Start</button><span>One</span><span>Two</span></div>
<ul><li>a</li></ul>
</body></html>`;

describe("applyEdits", () => {
  it("changes text and inline styles and keeps the rest", () => {
    const out = applyEdits(PAGE, [
      { type: "text", path: "/html[1]/body[1]/div[1]/button[1]", value: "Begin", check: { tag: "button", id: "go", cls: "btn" } },
      { type: "style", path: "/html[1]/body[1]/div[1]/button[1]", props: { "background-color": "#ff0000", color: "" } },
    ]);
    expect(out).toContain('<button id="go" class="btn primary" style="background-color: rgb(255, 0, 0);">Begin</button>');
    expect(out).toMatch(/^<!doctype html>\n<html>/);
    expect(out).toContain("<title>T</title>");
  });

  it("removes, duplicates and moves elements", () => {
    const out = applyEdits(PAGE, [
      { type: "duplicate", path: "/html[1]/body[1]/div[1]/button[1]" },
      { type: "move", path: "/html[1]/body[1]/div[1]/span[2]", target: "/html[1]/body[1]/ul[1]", place: "inside" },
      { type: "remove", path: "/html[1]/body[1]/div[1]/span[1]" },
    ]);
    expect(out).toContain('<button id="go" class="btn primary">Start</button><button class="btn primary">Start</button></div>');
    expect(out).toContain("<ul><li>a</li><span>Two</span></ul>");
    expect(out).not.toContain("One");
  });

  it("refuses an element the file does not hold as the page shows it", () => {
    expect(applyEdits(PAGE, [{ type: "remove", path: "/html[1]/body[1]/div[3]" }])).toBeNull();
    expect(applyEdits(PAGE, [{ type: "remove", path: "/html[1]/body[1]/div[1]/span[1]", check: { tag: "a" } }])).toBeNull();
    expect(applyEdits(PAGE, [{ type: "move", path: "/html[1]/body[1]/div[1]", target: "/html[1]/body[1]/div[1]/span[1]", place: "before" }])).toBeNull();
  });
});

describe("variables", () => {
  it("sets the first definition and leaves the rest", () => {
    const css = ":root { --accent: #0d9488; --accent-soft: #ccfbf1; }\n.dark { --accent: #2dd4bf; }";
    expect(setCssVariable(css, "--accent", "#ff0055")).toBe(":root { --accent: #ff0055; --accent-soft: #ccfbf1; }\n.dark { --accent: #2dd4bf; }");
    expect(setCssVariable(css, "--missing", "1px")).toBeNull();
  });

  it("sets a declaration without a semicolon, and not a longer name", () => {
    expect(setCssVariable(":root{--bg:#fff;--radius:8px}", "--radius", "12px")).toBe(":root{--bg:#fff;--radius:12px}");
    expect(setCssVariable(".card{--card--radius: 4px;}\n:root{--radius: 8px ;}", "--radius", "12px")).toBe(".card{--card--radius: 4px;}\n:root{--radius: 12px ;}");
    expect(setCssVariable(".card{--card--radius: 4px;}", "--radius", "12px")).toBeNull();
  });

  it("sets a variable in a page's own style", () => {
    const html = "<!doctype html><html><head><style>:root{--gap: 8px;}</style></head><body><p>x</p></body></html>";
    expect(setPageVariable(html, 0, "--gap", "12px")).toContain(":root{--gap: 12px;}");
    expect(setPageVariable(html, 1, "--gap", "12px")).toBeNull();
  });
});

describe("values", () => {
  it("reads and writes colors and lengths", () => {
    expect(toHex("rgb(24, 24, 27)")).toBe("#18181b");
    expect(toHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(px("12px")).toBe("12");
    expect(px("1.5rem")).toBe("1.5rem");
    expect(length("8")).toBe("8px");
    expect(length("50%")).toBe("50%");
  });
});
