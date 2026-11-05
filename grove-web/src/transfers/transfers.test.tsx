import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { trackedDownload } from "./download";
import { clearFinishedTransfers, startTransfer } from "./store";
import { TransferDock } from "./TransferDock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers });

async function renderDock() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<TransferDock />));
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

afterEach(() => {
  clearFinishedTransfers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("transfers", () => {
  it("streams a desktop download into the chosen file, then offers to open it", async () => {
    vi.spyOn(apiClient, "getResponse").mockResolvedValue(
      stream([new Uint8Array([1, 2]), new Uint8Array([3])], { "Content-Length": "3" }),
    );
    const invoke = vi.fn(async (cmd: string) =>
      cmd === "save_stream_begin" ? { id: "save-1", path: "/tmp/out.zip" } : undefined);
    const unmount = await renderDock();

    await act(async () => trackedDownload("/file", "out.zip", { invoke }));

    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "save_stream_begin", "save_stream_chunk", "save_stream_chunk", "save_stream_end",
    ]);
    expect(invoke).toHaveBeenCalledWith("save_stream_chunk", new Uint8Array([3]), { headers: { "x-grove-save-id": "save-1" } });
    expect(invoke).toHaveBeenLastCalledWith("save_stream_end", { id: "save-1", commit: true });
    expect(document.body.textContent).toContain("/tmp/out.zip");
    expect(document.body.textContent).toContain("1 finished");
    await unmount();
  });

  it("does nothing when the save dialog is dismissed", async () => {
    const fetchFile = vi.spyOn(apiClient, "getResponse");
    const unmount = await renderDock();
    await act(async () => trackedDownload("/file", "out.zip", { invoke: async () => null }));
    expect(fetchFile).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("out.zip");
    await unmount();
  });

  it("deletes the partial file when a download fails", async () => {
    vi.spyOn(apiClient, "getResponse").mockRejectedValue({ status: 500, message: "Disk on fire" });
    const invoke = vi.fn(async (cmd: string) =>
      cmd === "save_stream_begin" ? { id: "save-2", path: "/tmp/x" } : undefined);
    const unmount = await renderDock();
    await act(async () => trackedDownload("/file", "x", { invoke }));
    expect(invoke).toHaveBeenLastCalledWith("save_stream_end", { id: "save-2", commit: false });
    expect(document.body.textContent).toContain("Disk on fire");
    await unmount();
  });

  it("shows progress and cancels through the transfer's signal", async () => {
    const unmount = await renderDock();
    let transfer!: ReturnType<typeof startTransfer>;
    await act(async () => {
      transfer = startTransfer("upload", "big.bin", 2048);
      transfer.progress(1024);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    expect(document.body.textContent).toContain("1 transfer · 50%");

    await act(async () => {
      (document.querySelector('button[aria-label="Cancel big.bin"]') as HTMLButtonElement).click();
    });
    expect(transfer.signal.aborted).toBe(true);
    await act(async () => transfer.cancelled());
    expect(document.body.textContent).toContain("Cancelled");
    await unmount();
  });
});
