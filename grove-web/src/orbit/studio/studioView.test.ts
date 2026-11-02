import { describe, expect, it } from "vitest";
import type { ResourceFile } from "../../api";
import { INSTRUCTION_TEMPLATES } from "../../components/Studio/resourceModel";
import { availableTemplates, extLabel, fileKind, libraryCounts, linkHost, placeMenu, tileTitle } from "./studioView";

const file = (name: string, extra: Partial<ResourceFile> = {}): ResourceFile => ({
  name, path: name, size: 1, modified_at: "2026-10-01T00:00:00Z", is_dir: false, ...extra,
});

describe("studioView", () => {
  it("classifies files for thumbnails", () => {
    expect(fileKind("hero.PNG")).toBe("image");
    expect(fileKind("flow.excalidraw")).toBe("sketch");
    expect(fileKind("notes.md")).toBe("doc");
    expect(fileKind("figma.link.json")).toBe("link");
    expect(fileKind("data.json")).toBe("code");
    expect(fileKind("Makefile")).toBe("other");
    expect(fileKind(".env")).toBe("other");
  });

  it("labels extensions and link titles", () => {
    expect(extLabel("a.svg")).toBe("SVG");
    expect(extLabel("figma.link.json")).toBe("LINK");
    expect(extLabel("README")).toBe("");
    expect(tileTitle(file("figma.link.json"))).toBe("figma");
    expect(tileTitle(file("a.png"))).toBe("a.png");
    expect(linkHost(file("f.link.json", { url: "https://www.figma.com/file/x" }))).toBe("www.figma.com");
    expect(linkHost(file("f.link.json"))).toBe("External link");
  });

  it("summarizes what's at this level", () => {
    const files = [file("a.png"), file("b.md"), file("brand", { is_dir: true })];
    const linked = [{ name: "exports", target_path: "/x", exists: true }];
    expect(libraryCounts(files, linked, true)).toBe("2 files · 1 folder · 1 linked");
    expect(libraryCounts(files, linked, false)).toBe("2 files · 1 folder");
    expect(libraryCounts([file("a")], [], true)).toBe("1 file");
    expect(libraryCounts([], [], true)).toBe("0 files");
  });

  it("hides templates already in the instructions", () => {
    expect(availableTemplates("")).toHaveLength(INSTRUCTION_TEMPLATES.length);
    const used = INSTRUCTION_TEMPLATES[0].content;
    expect(availableTemplates(`intro\n\n${used}`).map((t) => t.label)).not.toContain(INSTRUCTION_TEMPLATES[0].label);
  });

  it("keeps menus on screen", () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 200, height: 160 };
    expect(placeMenu({ x: 100, y: 100 }, size, viewport)).toEqual({ left: 100, top: 100 });
    expect(placeMenu({ x: 990, y: 100 }, size, viewport)).toEqual({ left: 792, top: 100 });
    expect(placeMenu({ x: 500, y: 100, alignEnd: true }, size, viewport)).toEqual({ left: 300, top: 100 });
    expect(placeMenu({ x: 500, y: 700, flipY: 680 }, size, viewport)).toEqual({ left: 500, top: 520 });
    expect(placeMenu({ x: 500, y: 700 }, size, viewport)).toEqual({ left: 500, top: 540 });
  });
});
