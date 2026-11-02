import { describe, expect, it } from "vitest";
import type { Plugin } from "../../api/plugins";
import { findPluginPage, pluginPageEntries, pluginPageTitle } from "./pluginPages";

const plugins = [
  { id: "a", name: "Alpha", contributes: { sidebar: { title: "Alpha board" } } },
  { id: "b", name: "Beta", contributes: { panel: {} } },
  { id: "c", name: "Gamma", contributes: { sidebar: { title: "" } } },
] as unknown as Plugin[];

describe("plugin pages", () => {
  it("lists only sidebar contributions, titled by contributes.sidebar.title or the name", () => {
    expect(pluginPageEntries(plugins).map(({ id, label }) => [id, label])).toEqual([["plugin:a", "Alpha board"], ["plugin:c", "Gamma"]]);
    expect(pluginPageEntries(undefined)).toEqual([]);
    expect(pluginPageTitle(plugins[2])).toBe("Gamma");
  });

  it("resolves a page id to its installed plugin", () => {
    expect(findPluginPage(plugins, "plugin:a")?.name).toBe("Alpha");
    expect(findPluginPage(plugins, "plugin:b")).toBeUndefined();
    expect(findPluginPage(plugins, "plugin:zzz")).toBeUndefined();
    expect(findPluginPage(plugins, "dashboard")).toBeUndefined();
  });
});
