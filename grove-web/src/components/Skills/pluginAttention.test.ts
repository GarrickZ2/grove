import { describe, expect, it } from "vitest";
import type { Plugin } from "../../api/plugins";
import { pluginAttentionReasons } from "./pluginAttention";

const plugin = (status?: Plugin["status"]): Plugin => ({
  id: "pl-1", name: "P", version: "1", source: "local", local_path: "/p",
  created_at: "", updated_at: "", status,
});

describe("pluginAttentionReasons", () => {
  it("asks for a review of pending and changed plugins", () => {
    expect(pluginAttentionReasons(plugin("pending"))).toEqual(["Review to enable"]);
    expect(pluginAttentionReasons(plugin("changed"))).toEqual(["Permissions changed; review to re-enable"]);
  });

  it("is quiet for active plugins and servers without approval", () => {
    expect(pluginAttentionReasons(plugin("active"))).toEqual([]);
    expect(pluginAttentionReasons(plugin(undefined))).toEqual([]);
  });
});
