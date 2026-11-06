import { describe, expect, it, vi } from "vitest";
import { inlineRawAssets } from "./machineHtmlAssets";

const raw = "/api/v1/projects/p/tasks/t/file/raw?path=a.png";

describe("inlineRawAssets", () => {
  it("writes worktree assets into the document, once per file", async () => {
    const load = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    const html = await inlineRawAssets(`<img src="${raw}"><img src='${raw}'>`, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(html).toBe(`<img src="data:image/png;base64,eA=="><img src='data:image/png;base64,eA=='>`);
  });

  it("leaves other URLs and assets that fail to load alone", async () => {
    const html = `<img src="https://example.com/a.png"><img src="${raw}">`;
    expect(await inlineRawAssets(html, () => Promise.reject(new Error("gone")))).toBe(html);
  });
});
