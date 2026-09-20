// Frontend notification engine — the "notifications render where the human
// is" half of Grove's notification contract.
//
// The backend publishes attention facts (`hook_added` radio events) and
// persists the bell inbox; every surface renders its own transient
// presentation (banner + sound):
//
// - Tauri GUI: `notify_banner` / `play_sound` shell commands — the same
//   machinery the in-process Rust renderer uses, so native banner actions
//   (Approve / Deny / open) behave identically.
// - Browser: Web Notifications API + a synthesized chime.
//
// The engine stays quiet when the backend advertises
// `notification_owner: "backend"` (local GUI / `grove web`): its in-process
// renderer owns those. It activates when `grove mobile` advertises
// `notification_owner: "client"` on GET /api/v1/version, or when this GUI
// window attaches to a remote backend (shell says remote mode). The legacy
// `renders_os_notifications` boolean remains a fallback for older servers.

import { getVersion } from "../api/version";
import { getConfig, previewHookSound as previewBackendSound } from "../api/config";
import type { HooksConfig, NotificationsConfig } from "../api/config";
import type { RadioEvent } from "../api/walkieTalkie";
import { invokeQuiet, isTauriShell, isRemoteMode } from "../utils/tauriShell";
import {
  clientOwnsNotifications,
  hasInjectedRemoteBackend,
  isLikelyRemoteBrowser,
} from "./notificationRouting";

type HookAddedEvent = Extract<RadioEvent, { type: "hook_added" }>;

// ─── Activation: should this surface render notifications? ──────────────────

let activation: Promise<boolean> | null = null;

function engineActive(): Promise<boolean> {
  if (!activation) {
    const explicitlyRemote = isTauriShell
      ? isRemoteMode()
      : Promise.resolve(hasInjectedRemoteBackend());
    activation = explicitlyRemote.then(async (remote) => {
      if (remote) return true;
      try {
        return clientOwnsNotifications(await getVersion());
      } catch {
        // Do not permanently cache a transient startup/auth/network failure.
        activation = null;
        return false;
      }
    });
  }
  return activation;
}

// ─── Policy: user notification settings (cached, short TTL) ─────────────────

const CONFIG_TTL_MS = 30_000;
let policyCache: { notifications: NotificationsConfig; hooks: HooksConfig } | null =
  null;
let policyFetchedAt = 0;

async function loadPolicy() {
  if (policyCache && Date.now() - policyFetchedAt < CONFIG_TTL_MS) {
    return policyCache;
  }
  try {
    const cfg = await getConfig();
    policyCache = { notifications: cfg.notifications, hooks: cfg.hooks };
    policyFetchedAt = Date.now();
    return policyCache;
  } catch {
    // Fail closed: without the user's policy we don't render.
    return null;
  }
}

// ─── Presentation ────────────────────────────────────────────────────────────

function defaultLabel(kind: HookAddedEvent["kind"]): string {
  switch (kind) {
    case "permission_required":
      return "Permission Required";
    case "elicitation_required":
      return "Input Required";
    case "external":
      return "Notification";
    default:
      return "Task Complete";
  }
}

function composeTitle(event: HookAddedEvent): string {
  return `${event.project_name ?? "Grove"} - ${event.label ?? defaultLabel(event.kind)}`;
}

function composeBody(event: HookAddedEvent): string {
  const task = event.task_name ?? event.task_id;
  return event.message ? `${task} — ${event.message}` : task;
}

/** Port of the Rust banner-button matching: only explicit allow/deny kinds,
 *  no guessing. Null = no button on the banner. */
function matchActionOptions(event: HookAddedEvent): {
  approveOpt: string | null;
  denyOpt: string | null;
} {
  const options = event.permission?.options ?? [];
  const find = (pred: (kind: string) => boolean): string | null =>
    options.find((o) => pred(o.kind))?.option_id ?? null;
  const approveOpt =
    find((k) => k === "allow_once") ??
    find((k) => k === "allow_always") ??
    find((k) => k.includes("allow"));
  const denyOpt =
    find((k) => k === "reject_once") ??
    find((k) => k === "reject_always") ??
    find((k) => k.includes("reject") || k.includes("deny"));
  return { approveOpt, denyOpt };
}

function pickSound(
  kind: HookAddedEvent["kind"],
  hooks: HooksConfig,
): string | null {
  if (kind === "turn_complete" || kind === "external") {
    if (!hooks.response_sound_enabled) return null;
    return hooks.response_sound || "Glass";
  }
  if (kind === "permission_required") {
    if (!hooks.permission_sound_enabled) return null;
    return hooks.permission_sound || "Purr";
  }
  return null; // elicitation: silent, mirrors the backend renderer
}

function playSound(sound: string): void {
  if (isTauriShell) {
    void invokeQuiet("play_sound", { sound });
    return;
  }
  playBrowserChime();
}

/** Preview on the machine where the human is currently viewing Grove. */
export function previewNotificationSound(sound: string): Promise<void> {
  if (isTauriShell) {
    return invokeQuiet("play_sound", { sound }).then(() => undefined);
  }
  // Keep the AudioContext creation inside the click's user-activation window.
  if (isLikelyRemoteBrowser()) {
    playBrowserChime();
    return Promise.resolve();
  }
  return engineActive().then((active) => {
    if (active) {
      playBrowserChime();
      return;
    }
    return previewBackendSound(sound);
  });
}

/** Browsers can't play OS sound libraries — a short two-note chime instead. */
function playBrowserChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    // Audio unavailable — stay silent.
  }
}

function showBanner(event: HookAddedEvent): void {
  const title = composeTitle(event);
  const body = composeBody(event);
  const isPermission = event.kind === "permission_required";
  const { approveOpt, denyOpt } = isPermission
    ? matchActionOptions(event)
    : { approveOpt: null, denyOpt: null };

  if (isTauriShell) {
    void invokeQuiet("notify_banner", {
      title,
      body,
      projectId: event.project_id,
      taskId: event.task_id,
      chatId: event.chat_id ?? null,
      isPermission,
      approveOpt,
      denyOpt,
    });
    return;
  }

  showBrowserNotification(title, body, event);
}

function showBrowserNotification(
  title: string,
  body: string,
  event: HookAddedEvent,
): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    spawnBrowserNotification(title, body, event);
  } else if (Notification.permission === "default") {
    pendingBrowserNotification = { title, body, event };
    armBrowserPermission();
  }
}

function spawnBrowserNotification(
  title: string,
  body: string,
  event: HookAddedEvent,
): void {
  const tag = `grove:${event.project_id}:${event.task_id}`;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      // Same payload shape as tray:navigate — App.tsx applies it through the
      // shared navigation path (project select → task → chat).
      window.dispatchEvent(
        new CustomEvent("grove:navigate", {
          detail: {
            route: "tasks",
            project_id: event.project_id,
            task_id: event.task_id,
            chat_id: event.chat_id ?? null,
          },
        }),
      );
      n.close();
    };
  } catch {
    // Notification constructor unavailable (e.g. insecure origin).
  }
}

let pendingBrowserNotification: {
  title: string;
  body: string;
  event: HookAddedEvent;
} | null = null;

/** Request browser permission from a settings click and replay the first
 * pending event after approval. No-op for the Tauri shell and local browser. */
export function requestBrowserNotificationPermission(force = false): Promise<void> {
  if (
    isTauriShell ||
    (!force && !isLikelyRemoteBrowser()) ||
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "default"
  ) {
    return Promise.resolve();
  }
  // Keep this call synchronous with its caller's click/pointer gesture.
  try {
    return Notification.requestPermission()
      .then((permission) => {
        if (permission !== "granted") {
          pendingBrowserNotification = null;
          return;
        }
        if (!pendingBrowserNotification) return;
        const pending = pendingBrowserNotification;
        pendingBrowserNotification = null;
        spawnBrowserNotification(pending.title, pending.body, pending.event);
      })
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Browsers reject permission prompts raised outside a user gesture — a Radio
 * event callback doesn't count. Arm a one-shot pointer listener so the very
 * next interaction anywhere in the page requests permission; from then on
 * every banner renders. Any first event is retained and replayed after the
 * user grants permission.
 */
function armBrowserPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (permissionArmed || Notification.permission !== "default") return;
  permissionArmed = true;
  window.addEventListener(
    "pointerdown",
    () => {
      // engineActive() already established that this client owns rendering;
      // force covers localhost proxies/tunnels without guessing from the URL.
      void requestBrowserNotificationPermission(true);
    },
    { once: true },
  );
}
let permissionArmed = false;

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Render one attention fact as this surface's transient notification.
 *  Fire-and-forget: never throws into the caller's refresh flow. */
export function renderHookNotification(event: HookAddedEvent): void {
  void (async () => {
    try {
      if (!(await engineActive())) return;
      const policy = await loadPolicy();
      if (!policy) return;
      const n = policy.notifications;
      if (!n.notification_enabled) return;
      const show =
        event.kind === "permission_required"
          ? n.notification_show_permission
          : event.kind === "elicitation_required"
            ? n.notification_show_elicitation
            : n.notification_show_done;
      if (!show) return;

      const sound = pickSound(event.kind, policy.hooks);
      if (sound) playSound(sound);
      showBanner(event);
    } catch {
      // A notification must never break the app that hosts it.
    }
  })();
}
