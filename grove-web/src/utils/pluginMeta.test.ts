import { beforeEach, describe, expect, it } from "vitest";
import type { GroveMetaEnvelope } from "./groveMeta";
import { registerPluginMetaTypes, resolvePluginMeta } from "./pluginMeta";

const envelope = (over: Partial<GroveMetaEnvelope> = {}): GroveMetaEnvelope => ({
  v: 1,
  type: "plugin:pl-1/stock-alert",
  data: { symbol: "AAPL", change: "-4.2%", price: 187.5 },
  systemPrompt: "alert",
  source: { plugin_id: "pl-1", plugin_name: "Stock" },
  ...over,
});

describe("resolvePluginMeta", () => {
  beforeEach(() => {
    registerPluginMetaTypes([
      {
        id: "pl-1",
        status: "active",
        contributes: {
          metaTypes: [{
            type: "stock-alert",
            display: "card",
            template: {
              title: "{{symbol}} {{change}}",
              subtitle: "{{missing}}",
              badge: { text: "{{symbol}}", tone: "warning" },
              fields: [{ label: "Price", value: "{{price}}" }, { label: "Empty", value: "{{nope}}" }],
            },
          }],
        },
      },
      { id: "pl-2", status: "pending", contributes: { metaTypes: [{ type: "off" }] } },
    ]);
  });

  it("fills the template from the envelope's data", () => {
    expect(resolvePluginMeta(envelope())).toEqual({
      display: "card",
      pluginName: "Stock",
      icon: undefined,
      title: "AAPL -4.2%",
      subtitle: undefined,
      badge: { text: "AAPL", tone: "warning" },
      fields: [{ label: "Price", value: "187.5" }],
    });
  });

  it("refuses a type whose source is another plugin", () => {
    expect(resolvePluginMeta(envelope({ source: { plugin_id: "pl-9" } }))).toBeNull();
    expect(resolvePluginMeta(envelope({ source: undefined }))).toBeNull();
  });

  it("falls back for unknown types and plugins that are not active", () => {
    expect(resolvePluginMeta(envelope({ type: "plugin:pl-1/other" }))).toBeNull();
    expect(resolvePluginMeta(envelope({ type: "review_comment" }))).toBeNull();
    expect(resolvePluginMeta(envelope({
      type: "plugin:pl-2/off",
      source: { plugin_id: "pl-2" },
    }))).toBeNull();
  });

  it("keeps markup as plain text and ignores object values", () => {
    const resolved = resolvePluginMeta(envelope({
      data: { symbol: "<img src=x onerror=alert(1)>", change: { a: 1 } },
    }));
    expect(resolved?.title).toBe("<img src=x onerror=alert(1)> ");
  });

  it("does not trust an unknown tone", () => {
    registerPluginMetaTypes([{
      id: "pl-1",
      contributes: { metaTypes: [{ type: "stock-alert", template: { badge: { text: "x", tone: "red;" } } }] },
    }]);
    expect(resolvePluginMeta(envelope())?.badge?.tone).toBe("neutral");
  });
});
