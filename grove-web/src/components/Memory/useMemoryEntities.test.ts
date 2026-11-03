import { describe, expect, it, vi } from "vitest";
import { collectPages } from "./useMemoryEntities";

function pager(total: number, size: number) {
  return vi.fn(async (cursor?: string) => {
    const start = Number(cursor ?? 0);
    const items = Array.from({ length: Math.min(size, total - start) }, (_, i) => start + i);
    const next = start + size;
    return { items, next_cursor: next < total ? String(next) : undefined };
  });
}

describe("collectPages", () => {
  it("follows cursors to the end of the list", async () => {
    const fetchPage = pager(250, 100);
    const result = await collectPages(fetchPage, 600);
    expect(result.items).toHaveLength(250);
    expect(result.hasMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops at the cap and reports more", async () => {
    const fetchPage = pager(1000, 100);
    const result = await collectPages(fetchPage, 250);
    expect(result.items).toHaveLength(250);
    expect(result.hasMore).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
