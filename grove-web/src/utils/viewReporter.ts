import { apiClient } from "../api/client";

/** What this window is showing, reported so plugins can see every viewpoint. */
export interface ViewState {
  page: string | null;
  projectId: string | null;
  taskId: string | null;
  chatId: string | null;
  panel: string | null;
}

const SURFACE_KEY = "grove:surface-id";
const REPORT_DELAY_MS = 300;
const HEARTBEAT_MS = 30_000;

function surfaceId(): string {
  try {
    const known = sessionStorage.getItem(SURFACE_KEY);
    if (known) return known;
    const created = crypto.randomUUID();
    sessionStorage.setItem(SURFACE_KEY, created);
    return created;
  } catch {
    return memorySurface;
  }
}
const memorySurface = `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function clientKind(): "desktop" | "phone" | "web" {
  if ("__TAURI_INTERNALS__" in window) return "desktop";
  return window.matchMedia?.("(max-width: 640px)").matches ? "phone" : "web";
}

let view: ViewState = { page: null, projectId: null, taskId: null, chatId: null, panel: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

async function send(): Promise<void> {
  timer = null;
  try {
    await apiClient.post("/api/v1/view", {
      ...view,
      surfaceId: surfaceId(),
      client: clientKind(),
      focused: document.hasFocus(),
      visible: document.visibilityState === "visible",
    });
  } catch {
    // An older server, or a brief disconnect: the next report covers it.
  }
}

function schedule(): void {
  if (timer === null) timer = setTimeout(() => void send(), REPORT_DELAY_MS);
}

function start(): void {
  if (started) return;
  started = true;
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  document.addEventListener("visibilitychange", schedule);
  setInterval(schedule, HEARTBEAT_MS);
}

/** Merge a change into this window's view and report it shortly. */
export function updateView(change: Partial<ViewState>): void {
  start();
  const next = { ...view, ...change };
  if ((Object.keys(next) as (keyof ViewState)[]).every((key) => next[key] === view[key])) return;
  view = next;
  schedule();
}
