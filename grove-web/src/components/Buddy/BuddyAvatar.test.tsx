import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddyAvatar } from "./BuddyAvatar";
import { BUDDY_AVATAR_COLORS, BUDDY_AVATAR_RADIUS, BUDDY_AVATAR_SHAPES, resolveBuddyAvatar } from "./buddyAvatarConfig";

describe("BuddyAvatar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it.each(BUDDY_AVATAR_SHAPES)("renders the %s shape with two eyes", (shape) => {
    const color = BUDDY_AVATAR_COLORS[3];
    act(() => root.render(<BuddyAvatar id="release" avatar={JSON.stringify({ shape, color })} />));
    const avatar = host.querySelector<HTMLElement>(".buddy-av")!;
    expect(avatar.dataset.shape).toBe(shape);
    expect(avatar.dataset.color).toBe(color);
    expect(avatar.style.borderRadius).toBe(BUDDY_AVATAR_RADIUS[shape]);
    expect(avatar.querySelectorAll(".buddy-av__eyes > .buddy-av__eye")).toHaveLength(2);
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([16, 30, 34, 42, 48, 80])("sizes an avatar to %ipx and scales the em-sized eyes with it", (size) => {
    act(() => root.render(<BuddyAvatar id="chief" size={size} />));
    const avatar = host.querySelector<HTMLElement>(".buddy-av")!;
    expect(avatar.style.width).toBe(`${size}px`);
    expect(avatar.style.height).toBe(`${size}px`);
    expect(avatar.style.fontSize).toBe(`${size}px`);
    expect(avatar.querySelector(".buddy-av__eye")?.getAttribute("style")).toBeNull();
  });

  it("updates animation state and can provide an accessible name", () => {
    for (const state of ["idle", "working", "waiting"] as const) {
      act(() => root.render(<BuddyAvatar id="chief" state={state} label={`Chief: ${state}`} />));
      const avatar = host.querySelector<HTMLElement>(".buddy-av")!;
      expect(avatar.className).toBe(`buddy-av is-${state}`);
      expect(avatar.getAttribute("role")).toBe("img");
      expect(avatar.getAttribute("aria-label")).toBe(`Chief: ${state}`);
      expect(avatar.hasAttribute("aria-hidden")).toBe(false);
    }
  });

  it("keeps fallback identity across remounts and size/state changes", () => {
    act(() => root.render(<BuddyAvatar id="stable-buddy" avatar="broken" />));
    const before = host.querySelector<HTMLElement>(".buddy-av")!;
    const identity = [before.dataset.shape, before.dataset.color];
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<BuddyAvatar id="stable-buddy" size={80} state="working" />));
    const after = host.querySelector<HTMLElement>(".buddy-av")!;
    expect([after.dataset.shape, after.dataset.color]).toEqual(identity);
  });

  it("keeps eye sizing out of reach of caller descendant font-size rules", () => {
    const avatarCss = readFileSync("src/components/Buddy/buddy-avatar.css", "utf8");
    expect(avatarCss).toContain(".buddy-av .buddy-av__eyes,.buddy-av .buddy-av__eye{font-size:inherit;line-height:0}");
  });

  it("disables all avatar motion for reduced-motion preferences", () => {
    const avatarCss = readFileSync("src/components/Buddy/buddy-avatar.css", "utf8");
    expect(avatarCss).toContain("@media (prefers-reduced-motion: reduce){.buddy-av,.buddy-av *{animation:none !important}}");
  });
});

describe("stored avatar validation", () => {
  it.each([null, undefined, "", "not json", "null", "[]", "42", '{"shape":"triangle","color":"#10b981"}', '{"shape":"blob","color":"red"}', '{"shape":"blob"}'])(
    "falls back consistently for %s", (input) => {
      expect(resolveBuddyAvatar("buddy-123", input)).toEqual(resolveBuddyAvatar("buddy-123"));
    },
  );

  it("accepts every documented palette entry", () => {
    for (const color of BUDDY_AVATAR_COLORS) {
      expect(resolveBuddyAvatar("id", JSON.stringify({ shape: "blob", color }))).toEqual({ shape: "blob", color });
    }
  });

  it("maps avatars saved by the interim kind/color format", () => {
    expect(resolveBuddyAvatar("id", '{"kind":"acorn","color":"sun"}')).toEqual({ shape: "blob", color: "#f59e0b" });
    expect(resolveBuddyAvatar("id", '{"kind":"pot","color":"lagoon"}')).toEqual({ shape: "squircle", color: "#14b8a6" });
  });

  it("uses identity to distribute fallbacks across shapes and colors", () => {
    const values = Array.from({ length: 200 }, (_, index) => resolveBuddyAvatar(`buddy-${index}`));
    expect(new Set(values.map((value) => value.shape)).size).toBe(4);
    expect(new Set(values.map((value) => value.color)).size).toBe(7);
  });
});
