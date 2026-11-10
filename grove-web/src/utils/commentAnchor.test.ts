import { describe, expect, it } from "vitest";
import { describeAnchor, locateAnchor } from "./commentAnchor";

function page(body: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, "text/html");
}

const card = '<section><div><div><div><div><div><div><article class="card"><p>Same words</p></article></div></div></div></div></div></div></section>';

describe("comment anchors", () => {
  it("finds the element it was made on, in a whole page and under a root", () => {
    const doc = page("<main><p>Alpha</p><p>Bravo</p></main>");
    const bravo = doc.querySelectorAll("p")[1];
    expect(describeAnchor(bravo, doc)).toEqual({ selector: "body > main > p:nth-of-type(2)", xpath: "/html[1]/body[1]/main[1]/p[2]", text: "Bravo" });
    expect(locateAnchor(describeAnchor(bravo, doc), doc)).toEqual({ element: bravo, changed: false });

    const main = doc.querySelector("main")!;
    const under = describeAnchor(bravo, main);
    expect(under).toEqual({ selector: "p:nth-of-type(2)", xpath: "/p[2]", text: "Bravo" });
    expect(locateAnchor(under, main)).toEqual({ element: bravo, changed: false });
  });

  it("tells repeated blocks apart when the selector cannot", () => {
    const doc = page(card + card + card);
    const third = doc.querySelectorAll("p")[2];
    const anchor = describeAnchor(third, doc);
    expect(doc.querySelector(anchor.selector)).toBe(doc.querySelectorAll("p")[0]);
    expect(locateAnchor(anchor, doc)?.element).toBe(third);
  });

  it("follows an element that something was put in front of", () => {
    const anchor = describeAnchor(page("<p>Alpha</p><p>Bravo</p>").querySelectorAll("p")[1], page(""));
    const after = page("<p>New</p><p>Alpha</p><p>Bravo</p>");
    expect(locateAnchor({ ...anchor, selector: "body > p:nth-of-type(2)", xpath: "/html[1]/body[1]/p[2]" }, after)).toEqual({ element: after.querySelectorAll("p")[2], changed: false });
  });

  it("says when the element reads differently, and when it is gone", () => {
    const anchor = { selector: "body > p:nth-of-type(2)", xpath: "/html[1]/body[1]/p[2]", text: "Bravo" };
    const reworded = page("<p>Alpha</p><p>Bravo, reworded</p>");
    expect(locateAnchor(anchor, reworded)).toEqual({ element: reworded.querySelectorAll("p")[1], changed: true });
    expect(locateAnchor(anchor, page("<p>Alpha</p>"))).toBeNull();
  });

  it("takes an anchor without text, or with text cut short, as found", () => {
    const long = "word ".repeat(100).trim();
    const doc = page(`<p>${long}</p>`);
    const p = doc.querySelector("p")!;
    expect(locateAnchor({ selector: "body > p" }, doc)).toEqual({ element: p, changed: false });
    expect(describeAnchor(p, doc).text).toHaveLength(200);
    expect(locateAnchor(describeAnchor(p, doc), doc)?.changed).toBe(false);
    // An older anchor kept 300 characters.
    expect(locateAnchor({ selector: "body > p", text: long.slice(0, 300) }, doc)?.changed).toBe(false);
  });
});
