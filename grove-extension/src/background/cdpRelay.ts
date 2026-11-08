// Carries a browser driver's CDP connection into this browser.
//
// A driver expects a whole-browser connection, while `chrome.debugger` only
// attaches to one tab at a time and refuses the `Browser` and `Target`
// domains. So those commands are answered here from Chrome's own targets, with
// Chrome's own target ids, and everything else goes to the tab that owns the
// session. The driver sees every tab in the browser it can drive: some pages
// refuse extensions (browser pages, sites a policy blocks), and a driver that
// is shown one fails when it attaches, so tabs are attached before they are
// reported and stay attached while a driver is connected.

export type RelayEnv = {
  send: (message: object) => void;
  groupTab: (tabId: number, groupName?: string) => Promise<number | null>;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type Socket = {
  id: number;
  /** Tab group for tabs this connection opens, when the user wants them grouped. */
  group?: string;
  discovering: boolean;
  /** Top-level sessions this connection opened, by tab. */
  sessions: Map<number, string>;
};

/** `chrome.debugger` session source; child frames carry their own session id. */
type DebuggerSource = chrome.debugger.Debuggee & { sessionId?: string };

type TargetInfo = {
  targetId: string;
  type: 'page';
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: false;
};

const sockets = new Map<number, Socket>();
/** Which tab each session belongs to, including child frames. */
const sessionTabs = new Map<string, number>();
const attachedTabs = new Set<number>();
/** Attaches under way, so tabs listed twice at once are attached once. */
const attaching = new Map<number, Promise<boolean>>();
/** Tabs that refused attaching, with the page they were on then. */
const refusedTabs = new Map<number, string>();
/** Chrome's target id for each tab, kept so a closed tab can still be named. */
const targetIds = new Map<number, string>();
/** Fallback capture loops, by session. See `startCapture`. */
const captures = new Map<string, ReturnType<typeof setInterval>>();
/** When Chrome last sent a screencast frame, by session. */
const lastScreencastFrames = new Map<string, number>();

let env: RelayEnv | null = null;

export const RELAY_CAPABILITY = 'browser.cdp_relay';
const CAPTURE_INTERVAL_MS = 500;
/** Chrome's own frames are arriving if one came this recently. */
const SCREENCAST_FRESH_MS = 1000;

function reply(socket: Socket, message: object) {
  env?.send({ type: 'CDP_OUT', socket: socket.id, data: JSON.stringify(message) });
}

function emit(socket: Socket, method: string, params: object, sessionId?: string) {
  reply(socket, sessionId ? { method, params, sessionId } : { method, params });
}

function emitToDiscovering(method: string, params: object) {
  for (const socket of sockets.values()) {
    if (socket.discovering) emit(socket, method, params);
  }
}

/** Whether a driver can use this tab: attaches to it unless it already is. */
async function attachable(tabId: number, url: string): Promise<boolean> {
  if (attachedTabs.has(tabId)) return true;
  if (refusedTabs.get(tabId) === url) return false;
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = chrome.debugger
      .attach({ tabId }, '1.3')
      .then(() => {
        attachedTabs.add(tabId);
        refusedTabs.delete(tabId);
        return true;
      })
      .catch(() => {
        refusedTabs.set(tabId, url);
        return false;
      })
      .finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

/** Every tab a driver can use, as CDP page targets. */
async function pageTargets(): Promise<{ tabId: number; info: TargetInfo }[]> {
  if (sockets.size === 0) return [];
  const pages = (await chrome.debugger.getTargets()).filter(
    (target) => target.type === 'page' && target.tabId !== undefined,
  );
  const usable = await Promise.all(
    pages.map((target) => attachable(target.tabId as number, target.url)),
  );
  return pages
    .filter((_, index) => usable[index])
    .map((target) => {
      const tabId = target.tabId as number;
      targetIds.set(tabId, target.id);
      return {
        tabId,
        info: {
          targetId: target.id,
          type: 'page' as const,
          title: target.title,
          url: target.url,
          attached: target.attached,
          canAccessOpener: false as const,
        },
      };
    });
}

async function tabFor(targetId: unknown): Promise<number> {
  const found = (await pageTargets()).find((target) => target.info.targetId === targetId);
  if (!found) throw new Error(`No target with given id found`);
  return found.tabId;
}

async function infoFor(tabId: number): Promise<TargetInfo | null> {
  return (await pageTargets()).find((target) => target.tabId === tabId)?.info ?? null;
}

async function attach(socket: Socket, tabId: number): Promise<string> {
  const existing = socket.sessions.get(tabId);
  if (existing) return existing;
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  }
  const sessionId = `grove-session-${socket.id}-${tabId}`;
  socket.sessions.set(tabId, sessionId);
  sessionTabs.set(sessionId, tabId);
  const info = await infoFor(tabId);
  if (info) {
    emit(socket, 'Target.attachedToTarget', {
      sessionId,
      targetInfo: { ...info, attached: true },
      waitingForDebugger: false,
    });
  }
  return sessionId;
}

/** Once no driver is connected, leave every tab. */
function detachAllWhenUnused() {
  if (sockets.size > 0) return;
  for (const tabId of attachedTabs) void chrome.debugger.detach({ tabId }).catch(() => {});
  attachedTabs.clear();
  refusedTabs.clear();
}

async function createTarget(socket: Socket, params: Record<string, unknown>): Promise<string> {
  const tab = await chrome.tabs.create({
    url: String(params.url ?? '') || 'about:blank',
    active: params.background !== true,
  });
  if (tab.id === undefined) throw new Error('The browser did not open a tab');
  await env?.groupTab(tab.id, socket.group);
  // Chrome lists a new tab as a target a moment after creating it.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await infoFor(tab.id);
    if (info) return info.targetId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The new tab did not become a target');
}

/** The user agent string hides the patch version, which the driver reports on. */
async function browserProduct(): Promise<string> {
  const fallback = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'Chrome';
  const data = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ uaFullVersion?: string }> };
  }).userAgentData;
  const version = await data?.getHighEntropyValues(['uaFullVersion']).catch(() => undefined);
  return version?.uaFullVersion ? `Chrome/${version.uaFullVersion}` : fallback;
}

/** Commands with no session: the ones a real browser endpoint would answer. */
async function handleBrowserCommand(socket: Socket, message: CdpMessage): Promise<object> {
  const params = message.params ?? {};
  switch (message.method) {
    case 'Browser.getVersion':
      return {
        protocolVersion: '1.3',
        product: await browserProduct(),
        revision: '',
        userAgent: navigator.userAgent,
        jsVersion: '',
      };
    case 'Target.setDiscoverTargets': {
      socket.discovering = params.discover !== false;
      if (socket.discovering) {
        for (const { info } of await pageTargets()) {
          emit(socket, 'Target.targetCreated', { targetInfo: info });
        }
      }
      return {};
    }
    case 'Target.getTargets':
      return { targetInfos: (await pageTargets()).map((target) => target.info) };
    case 'Target.getTargetInfo': {
      const info = await infoFor(await tabFor(params.targetId));
      if (!info) throw new Error('No target with given id found');
      return { targetInfo: info };
    }
    case 'Target.createTarget':
      return { targetId: await createTarget(socket, params) };
    case 'Target.attachToTarget':
      return { sessionId: await attach(socket, await tabFor(params.targetId)) };
    case 'Target.detachFromTarget': {
      const tabId = sessionTabs.get(String(params.sessionId));
      if (tabId !== undefined && socket.sessions.get(tabId) === params.sessionId) {
        socket.sessions.delete(tabId);
        sessionTabs.delete(String(params.sessionId));
      }
      return {};
    }
    case 'Target.activateTarget':
      // Bringing a tab to the front would take the user's own screen; the
      // driver works in background tabs without it.
      await tabFor(params.targetId);
      return {};
    case 'Target.closeTarget':
      await chrome.tabs.remove(await tabFor(params.targetId));
      return { success: true };
    case 'Target.setAutoAttach':
      return {};
    case 'Browser.close':
      // This is the user's own browser: a driver closing its connection must
      // not close it.
      return {};
    default:
      throw new Error(`'${message.method}' wasn't found`);
  }
}

type PageView = { width: number; height: number; left: number; top: number; scale: number };

/** A page held by a dialog cannot answer, so its size is not waited for. */
const PAGE_VIEW_TIMEOUT_MS = 1000;

async function pageView(tabId: number): Promise<PageView> {
  const evaluated = (await Promise.race([
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '[innerWidth, innerHeight, visualViewport.pageLeft, visualViewport.pageTop, devicePixelRatio]',
      returnByValue: true,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The page did not answer')), PAGE_VIEW_TIMEOUT_MS)),
  ])) as { result?: { value?: number[] } };
  const [width, height, left, top, scale] = evaluated.result?.value ?? [];
  if (!width || !height) throw new Error('The page has no size');
  return { width, height, left: left ?? 0, top: top ?? 0, scale: scale || 1 };
}

/** Screencast settings that make each frame exactly the page's size. */
function framedAtPageSize(params: Record<string, unknown> | undefined, view: PageView) {
  return { ...params, maxWidth: Math.round(view.width), maxHeight: Math.round(view.height) };
}

/**
 * The live view shows the user's own page, whose size the driver does not
 * know: it reports the size it would give a browser it launched. So frames
 * are made exactly the page's size, and the panel reads the size from them.
 *
 * Chrome produces no screencast frames for a tab nobody can see: a background
 * tab, or the active tab of a covered window. It can still capture them, so
 * whenever its own frames stop, the tab is captured at a low rate and
 * delivered as ordinary screencast frames. When the page changes size, the
 * screencast is restarted at the new size.
 */
function startCapture(
  socket: Socket,
  tabId: number,
  sessionId: string,
  params: Record<string, unknown> | undefined,
  started: PageView,
) {
  stopCapture(sessionId);
  let capturing = false;
  let size = `${started.width}x${started.height}`;
  const capture = async () => {
    if (capturing) return;
    capturing = true;
    try {
      const view = await pageView(tabId);
      if (`${view.width}x${view.height}` !== size) {
        size = `${view.width}x${view.height}`;
        // Chrome refuses to start a screencast that is already running.
        await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast', {});
        await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', framedAtPageSize(params, view));
      }
      const lastFrame = lastScreencastFrames.get(sessionId) ?? 0;
      if (Date.now() - lastFrame < SCREENCAST_FRESH_MS) return;
      const shot = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
        clip: { x: view.left, y: view.top, width: view.width, height: view.height, scale: 1 / view.scale },
      })) as { data: string };
      emit(socket, 'Page.screencastFrame', {
        data: shot.data,
        sessionId: Date.now() % 2147483647,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: view.width,
          deviceHeight: view.height,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: Date.now() / 1000,
        },
      }, sessionId);
    } catch {
      stopCapture(sessionId);
    } finally {
      capturing = false;
    }
  };
  captures.set(sessionId, setInterval(() => void capture(), CAPTURE_INTERVAL_MS));
}

function stopCapture(sessionId: string) {
  const timer = captures.get(sessionId);
  if (timer !== undefined) clearInterval(timer);
  captures.delete(sessionId);
  lastScreencastFrames.delete(sessionId);
}

async function handleCommand(socket: Socket, message: CdpMessage): Promise<object> {
  if (!message.sessionId) return handleBrowserCommand(socket, message);
  const tabId = sessionTabs.get(message.sessionId);
  if (tabId === undefined) {
    throw new Error(`Session with given id not found: ${message.sessionId}`);
  }
  // Same as `Target.activateTarget`: never take the user's screen.
  if (message.method === 'Page.bringToFront') return {};
  // Top-level sessions are ours; child frames use Chrome's own ids.
  const isChild = socket.sessions.get(tabId) !== message.sessionId;
  let params = message.params;
  if (message.method === 'Page.startScreencast' && !isChild) {
    const view = await pageView(tabId).catch(() => null);
    if (view) {
      startCapture(socket, tabId, message.sessionId, message.params, view);
      params = framedAtPageSize(message.params, view);
    }
  }
  if (message.method === 'Page.stopScreencast') stopCapture(message.sessionId);
  const debuggee: DebuggerSource = isChild ? { tabId, sessionId: message.sessionId } : { tabId };
  const result = await chrome.debugger.sendCommand(debuggee, message.method ?? '', params);
  return (result as object | undefined) ?? {};
}

async function handleFrame(socket: Socket, frame: string) {
  const message = JSON.parse(frame) as CdpMessage;
  const base = { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}) };
  try {
    reply(socket, { ...base, result: await handleCommand(socket, message) });
  } catch (error) {
    reply(socket, { ...base, error: { code: -32000, message: (error as Error).message } });
  }
}

function closeSocket(socket: Socket) {
  sockets.delete(socket.id);
  for (const sessionId of socket.sessions.values()) stopCapture(sessionId);
  for (const sessionId of socket.sessions.values()) sessionTabs.delete(sessionId);
  socket.sessions.clear();
  detachAllWhenUnused();
}

function ownerOf(tabId: number): Socket | undefined {
  return [...sockets.values()].find((socket) => socket.sessions.has(tabId));
}

function onDebuggerEvent(source: DebuggerSource, method: string, params?: object) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const socket = ownerOf(tabId);
  if (!socket) return;
  if (method === 'Target.attachedToTarget') {
    const child = (params as { sessionId?: string } | undefined)?.sessionId;
    if (child) sessionTabs.set(child, tabId);
  }
  if (method === 'Target.detachedFromTarget') {
    const child = (params as { sessionId?: string } | undefined)?.sessionId;
    if (child) sessionTabs.delete(child);
  }
  const sessionId = source.sessionId ?? socket.sessions.get(tabId);
  if (method === 'Page.screencastFrame' && sessionId) lastScreencastFrames.set(sessionId, Date.now());
  emit(socket, method, params ?? {}, sessionId);
}

function onDebuggerDetach(source: chrome.debugger.Debuggee) {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  attachedTabs.delete(tabId);
  const targetId = targetIds.get(tabId) ?? '';
  for (const socket of sockets.values()) {
    const sessionId = socket.sessions.get(tabId);
    if (!sessionId) continue;
    socket.sessions.delete(tabId);
    sessionTabs.delete(sessionId);
    stopCapture(sessionId);
    emit(socket, 'Target.detachedFromTarget', { sessionId, targetId });
  }
}

async function onTabCreated(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await infoFor(tab.id);
    if (info) {
      emitToDiscovering('Target.targetCreated', { targetInfo: info });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function onTabUpdated(tabId: number) {
  const info = await infoFor(tabId);
  if (info) emitToDiscovering('Target.targetInfoChanged', { targetInfo: info });
}

function onTabRemoved(tabId: number) {
  const targetId = targetIds.get(tabId);
  targetIds.delete(tabId);
  attachedTabs.delete(tabId);
  refusedTabs.delete(tabId);
  for (const socket of sockets.values()) {
    const sessionId = socket.sessions.get(tabId);
    if (!sessionId) continue;
    socket.sessions.delete(tabId);
    sessionTabs.delete(sessionId);
    stopCapture(sessionId);
    emit(socket, 'Target.detachedFromTarget', { sessionId, targetId });
  }
  for (const [sessionId, owner] of sessionTabs) {
    if (owner === tabId) sessionTabs.delete(sessionId);
  }
  if (targetId) emitToDiscovering('Target.targetDestroyed', { targetId });
}

export function installRelay(relayEnv: RelayEnv) {
  env = relayEnv;
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);
  chrome.tabs.onCreated.addListener((tab) => void onTabCreated(tab));
  chrome.tabs.onUpdated.addListener((tabId) => void onTabUpdated(tabId));
  chrome.tabs.onRemoved.addListener(onTabRemoved);
}

/** Returns false for messages that are not relay traffic. */
export function handleRelayMessage(message: {
  type?: string;
  socket?: number;
  group?: string | null;
  data?: string;
}): boolean {
  switch (message.type) {
    case 'CDP_OPEN':
      sockets.set(message.socket as number, {
        id: message.socket as number,
        group: message.group ?? undefined,
        discovering: false,
        sessions: new Map(),
      });
      return true;
    case 'CDP_IN': {
      const socket = sockets.get(message.socket as number);
      if (socket) void handleFrame(socket, message.data as string);
      return true;
    }
    case 'CDP_CLOSE': {
      const socket = sockets.get(message.socket as number);
      if (socket) closeSocket(socket);
      return true;
    }
    default:
      return false;
  }
}

/** The connection to Grove dropped, taking every relayed socket with it. */
export function closeAllSockets() {
  for (const socket of [...sockets.values()]) closeSocket(socket);
}
