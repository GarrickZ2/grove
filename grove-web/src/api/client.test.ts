// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, clearSecretKey, setSecretKey } from "./client";

describe("ApiClient JSON responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSecretKey();
  });

  it("rejects a SPA fallback page returned for a missing API route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));

    await expect(apiClient.get("/api/v1/missing-route")).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining("Restart Grove"),
    });
  });

  it("continues to parse valid API JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(apiClient.get("/api/v1/example")).resolves.toEqual({ ok: true });
  });

  it("sends signed HEAD requests for existence probes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setSecretKey("test-secret");

    await expect(apiClient.head("/api/v1/example")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/example",
      expect.objectContaining({
        method: "HEAD",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Timestamp": expect.any(String),
          "X-Nonce": expect.any(String),
          "X-Signature": expect.any(String),
        }),
        cache: "no-store",
      }),
    );
  });
});
