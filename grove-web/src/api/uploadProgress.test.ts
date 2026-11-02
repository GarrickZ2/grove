import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";

class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getAllResponseHeaders() { return "content-type: application/json\r\n"; }
  send() {}
  abort() { this.onabort?.(); }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

describe("postFormDataWithProgress", () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeXhr.last = null; });

  it("reports upload progress and resolves with the JSON body", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const seen: number[] = [];
    const pending = apiClient.postFormDataWithProgress<{ ok: boolean }>("/api/v1/x/upload", new FormData(), (f) => seen.push(f));
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("/api/v1/x/upload");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.respond(200, JSON.stringify({ ok: true }));
    await expect(pending).resolves.toEqual({ ok: true });
    expect(seen).toEqual([0.25, 1, 1]);
  });

  it("rejects with the API error shape on a non-2xx response", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const pending = apiClient.postFormDataWithProgress("/api/v1/x/upload", new FormData(), () => {});
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    FakeXhr.last!.respond(413, JSON.stringify({ error: "File too large" }));
    await expect(pending).rejects.toMatchObject({ status: 413, message: "File too large" });
  });
});
