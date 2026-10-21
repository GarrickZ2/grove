export const BACKGROUND_CHAT_IDLE_MS = 10 * 60 * 1000;

/** Owns intentional detachment independently of WebSocket onclose callbacks.
 * Automatic recovery never clears this state; only observing a session does.
 */
export class BackgroundChatConnections {
  private activity = new Map<string, number>();
  private released: Set<string>;
  private generation = 0;
  private mounted = true;

  private storageKey: string;
  private storage?: Pick<Storage, "getItem" | "setItem">;

  constructor(storageKey: string, storage?: Pick<Storage, "getItem" | "setItem">) {
    this.storageKey = storageKey;
    this.storage = storage;
    try {
      const saved: unknown = storage?.getItem(storageKey);
      const ids: unknown = typeof saved === "string" ? JSON.parse(saved) : [];
      this.released = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    } catch { this.released = new Set(); }
  }

  private save(added: Iterable<string>, removed: string[] = []) {
    try {
      // Multiple keep-alive/split panels can share this task. Merge only our
      // changes so one panel cannot erase another panel's release marker.
      const saved: unknown = JSON.parse(this.storage?.getItem(this.storageKey) ?? "[]");
      const merged = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
      for (const id of added) merged.add(id);
      for (const id of removed) merged.delete(id);
      this.storage?.setItem(this.storageKey, JSON.stringify([...merged]));
    } catch { /* optional cache */ }
  }

  mount() { this.mounted = true; }
  unmount() {
    this.mounted = false;
    this.generation += 1;
    this.activity.forEach((_, id) => this.released.add(id));
    this.save(this.activity.keys());
  }
  canConnect(id: string) { return this.mounted && !this.released.has(id); }
  ticket() { return this.generation; }
  canFinishConnect(id: string, ticket: number) { return this.canConnect(id) && ticket === this.generation; }
  track(id: string, now: number) { if (!this.activity.has(id)) this.activity.set(id, now); }
  recordActivity(id: string, now: number) { this.activity.set(id, now); }

  /** Called on a real transition into a visible session, not on recovery. */
  observe(id: string) {
    const resumed = this.released.delete(id);
    if (resumed) this.save([], [id]);
    return resumed;
  }

  releaseIdle(observedId: string | null, now: number, canRelease: (id: string) => boolean = () => true): string[] {
    const ids: string[] = [];
    this.activity.forEach((lastActivity, id) => {
      if (id !== observedId && !this.released.has(id) && now - lastActivity >= BACKGROUND_CHAT_IDLE_MS && canRelease(id)) {
        this.released.add(id);
        ids.push(id);
      }
    });
    if (ids.length) this.save(ids);
    return ids;
  }
}

/** Wrap this socket only, so every send path shares the same activity clock. */
export function trackChatSocketSends(socket: WebSocket, activity: () => void) {
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    send(data);
    activity();
  };
}

/** Visibility follows the chat panel, not keyboard focus in its composer. */
export function watchBackgroundChatConnections(options: {
  connections: BackgroundChatConnections;
  root: HTMLElement | null;
  getActiveChatId: () => string | null;
  disabled: () => boolean;
  canRelease?: (id: string) => boolean;
  onResume: (id: string) => void;
  onRelease: (id: string) => void;
}) {
  const { connections, root } = options;
  let previousObserved: string | null = null;
  connections.mount();
  const inspect = () => {
    const visible = !options.disabled() && document.visibilityState === "visible"
      && !!root && root.getClientRects().length > 0
      && root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().height > 0;
    const observed = visible ? options.getActiveChatId() : null;
    if (observed !== previousObserved) {
      previousObserved = observed;
      if (observed && connections.observe(observed)) options.onResume(observed);
    }
    connections.releaseIdle(observed, Date.now(), options.canRelease).forEach((id) => options.onRelease(id));
  };
  inspect();
  const timer = window.setInterval(inspect, 5000);
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(inspect);
  if (root) resize?.observe(root);
  document.addEventListener("visibilitychange", inspect);
  return () => {
    window.clearInterval(timer);
    resize?.disconnect();
    document.removeEventListener("visibilitychange", inspect);
  };
}
