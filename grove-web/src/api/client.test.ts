// @vitest-environment jsdom

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, appendHmacToUrl, clearSecretKey, setDeviceSession, setSecretKey } from "./client";

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

  it("fetches binary previews with signed GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    setSecretKey("test-secret");

    const blob = await apiClient.getBlob("/api/v1/example/download?path=image.jpeg");
    expect(blob.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/example/download?path=image.jpeg",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Timestamp": expect.any(String),
          "X-Nonce": expect.any(String),
          "X-Signature": expect.any(String),
        }),
        cache: "no-store",
      }),
    );
  });
});

describe("request signatures match transmitted URLs", () => {
  const key = "b".repeat(64);
  const deviceId = "a".repeat(64);
  const encodedTask = encodeURIComponent("智能化建设");

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  function signature(timestamp: string, nonce: string, method: string, path: string) {
    // Independent HMAC implementation; do not reuse the client's canonicalizer.
    return createHmac("sha256", key).update(`${timestamp}|${nonce}|${method}|${path}`).digest("hex");
  }

  const cases: { name: string; path: string; wirePath: string; canonical?: string }[] = [
    ...["linked-projects", "commits", "diff", "stats"].map(endpoint => ({
      name: `Chinese task ${endpoint}`,
      path: `/api/v1/projects/demo/tasks/智能化建设/${endpoint}`,
      wirePath: `/api/v1/projects/demo/tasks/${encodedTask}/${endpoint}`,
    })),
    {
      name: "English task",
      path: "/api/v1/projects/demo/tasks/knowledge-base/linked-projects",
      wirePath: "/api/v1/projects/demo/tasks/knowledge-base/linked-projects",
    },
    {
      name: "already encoded task",
      path: `/api/v1/projects/demo/tasks/${encodedTask}/linked-projects`,
      wirePath: `/api/v1/projects/demo/tasks/${encodedTask}/linked-projects`,
    },
    {
      name: "Chinese query with spaces and existing escapes",
      path: "/api/v1/search?z=智能 建设&a=%2Fdocs%2f&z=ok",
      wirePath: `/api/v1/search?z=${encodeURIComponent("智能 建设")}&a=%2Fdocs%2f&z=ok`,
      canonical: `/api/v1/search?a=%2Fdocs%2f&z=${encodeURIComponent("智能 建设")}&z=ok`,
    },
  ];

  describe.each(["device", "master"] as const)("%s credentials", credential => {
    it.each(cases)("signs $name using the transmitted path", async ({ path, wirePath, canonical }) => {
      if (credential === "device") setDeviceSession(deviceId, key);
      else setSecretKey(key);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      await apiClient.get(path);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const transmitted = new URL(url, window.location.origin);
      expect(transmitted.pathname + transmitted.search).toBe(wirePath);
      const headers = new Headers(init.headers);
      expect(headers.get("X-Device-Id")).toBe(credential === "device" ? deviceId : null);
      expect(headers.get("X-Signature")).toBe(signature(
        headers.get("X-Timestamp")!, headers.get("X-Nonce")!, init.method!, canonical ?? wirePath,
      ));
    });

    it("preserves WebSocket signatures for Chinese paths and query parameters", async () => {
      if (credential === "device") setDeviceSession(deviceId, key);
      else setSecretKey(key);
      const url = new URL(await appendHmacToUrl(
        "ws://localhost/api/v1/projects/demo/tasks/智能化建设/ws?session_id=中文 会话",
      ));
      const query = credential === "device"
        ? `device_id=${deviceId}&session_id=${encodeURIComponent("中文")}+${encodeURIComponent("会话")}`
        : `session_id=${encodeURIComponent("中文 会话")}`;
      expect(url.pathname).toBe(`/api/v1/projects/demo/tasks/${encodedTask}/ws`);
      expect(url.searchParams.get("device_id")).toBe(credential === "device" ? deviceId : null);
      expect(url.searchParams.get("sig")).toBe(signature(
        url.searchParams.get("ts")!, url.searchParams.get("nonce")!, "GET", `${url.pathname}?${query}`,
      ));
    });
  });

  it("signs FormData uploads through the auth-only header path", async () => {
    setDeviceSession(deviceId, key);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.postFormData("/api/v1/projects/demo/tasks/智能化建设/upload", new FormData());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const transmitted = new URL(url, window.location.origin);
    const headers = new Headers(init.headers);
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("X-Device-Id")).toBe(deviceId);
    expect(headers.get("X-Signature")).toBe(signature(
      headers.get("X-Timestamp")!, headers.get("X-Nonce")!, "POST", transmitted.pathname,
    ));
  });
});
