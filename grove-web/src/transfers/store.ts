import { useSyncExternalStore } from "react";

export type TransferKind = "upload" | "download";
export type TransferStatus = "active" | "done" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  kind: TransferKind;
  name: string;
  loaded: number;
  /** null while the size is unknown, e.g. a zip being built on the fly. */
  total: number | null;
  status: TransferStatus;
  error?: string;
  /** Where a desktop download landed; browsers don't tell us. */
  path?: string;
}

export interface TransferHandle {
  signal: AbortSignal;
  progress(loaded: number, total?: number | null): void;
  finish(path?: string): void;
  fail(message: string): void;
  /** The transfer was aborted; records nothing further once settled. */
  cancelled(): void;
}

/** Finished rows kept for the session; this only ever lives in memory. */
const FINISHED_LIMIT = 50;
const NOTIFY_INTERVAL_MS = 100;

let transfers: Transfer[] = [];
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let nextId = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  for (const listener of listeners) listener();
}

/** Chunks arrive far faster than anyone can read a percentage. */
function notifySoon() {
  notifyTimer ??= setTimeout(notify, NOTIFY_INTERVAL_MS);
}

function patch(id: string, change: Partial<Transfer>, soon = false) {
  transfers = transfers.map((item) => (item.id === id ? { ...item, ...change } : item));
  if (soon) notifySoon();
  else notify();
}

function settle(id: string, change: Partial<Transfer>) {
  controllers.delete(id);
  patch(id, change);
  const finished = transfers.filter((item) => item.status !== "active");
  const excess = new Set(finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT)).map((item) => item.id));
  if (excess.size > 0) {
    transfers = transfers.filter((item) => !excess.has(item.id));
    notify();
  }
}

export function startTransfer(kind: TransferKind, name: string, total: number | null = null): TransferHandle {
  const id = `transfer-${++nextId}`;
  const controller = new AbortController();
  controllers.set(id, controller);
  transfers = [...transfers, { id, kind, name, loaded: 0, total, status: "active" }];
  notify();
  return {
    signal: controller.signal,
    progress: (loaded, nextTotal) =>
      patch(id, { loaded, ...(nextTotal === undefined ? {} : { total: nextTotal }) }, true),
    finish: (path) => {
      const current = transfers.find((item) => item.id === id);
      settle(id, { status: "done", path, ...(current?.total ? { loaded: current.total } : {}) });
    },
    fail: (error) => settle(id, { status: "failed", error }),
    cancelled: () => settle(id, { status: "cancelled" }),
  };
}

export function cancelTransfer(id: string) {
  controllers.get(id)?.abort();
}

export function clearFinishedTransfers() {
  transfers = transfers.filter((item) => item.status === "active");
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => transfers;

export function useTransfers(): Transfer[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
