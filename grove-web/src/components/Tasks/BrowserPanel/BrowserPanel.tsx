import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { Globe, Maximize2, Minimize2, Monitor, X } from "lucide-react";
import { Button, PanelEmpty, PanelHeaderActions, PanelHeaderContext } from "../../../orbit/ui";
import {
  browserStreamUrl,
  computerScreenshotPath,
  getBrowserStatus,
  getComputerShots,
  closeComputerTab,
  switchBrowserTab,
  type BrowserStatus,
  type BrowserTarget,
  type ComputerShot,
} from "../../../api/browser";
import { useSignedUrl } from "../../../orbit/studio/useSignedUrl";
import {
  describeCommand,
  fitFrame,
  keyText,
  modifierBits,
  mouseButton,
  pageSize,
  textToKeys,
  toPagePoint,
  isInputMethodKey,
} from "./browserInput";
import { shownBrowser, tabKey, tabRows, type BrowserPick, type BrowserTab, type TabRow, type TabsByBrowser } from "./browserTabs";
import { hasMacWindowControls } from "../../../orbit/ui/windowControls";
import "./BrowserPanel.css";

const STATUS_POLL_MS = 1500;
const RECONNECT_MS = 2000;
/** Enough to follow an agent; the page itself decides how often frames change. */
const MAX_FPS = 10;
/** The browser not on screen only has to keep its tab list and last frame fresh. */
const BACKGROUND_FPS = 1;
/** How long a finished action stays on screen. The chat holds the full history. */
const ACTIVITY_LINGER_MS = 2500;
/** The driver reports this on every call; it says nothing about the page. */
const BOOKKEEPING_ACTIONS = new Set(["launch"]);
const MOUSE_MOVE_INTERVAL_MS = 50;

interface Activity {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
}

type StreamMessage = {
  type: string;
  /** Base64 image on a frame, the outcome on a result. */
  data?: unknown;
  metadata?: { deviceWidth: number };
  viewportWidth?: number;
  /** On a status: whether the browser is running at all. */
  connected?: boolean;
  url?: string;
  id?: string;
  action?: string;
  params?: Record<string, unknown>;
  tabs?: BrowserTab[];
};

interface BrowserPanelProps {
  projectId: string;
  taskId: string;
}

function newestShot(shots: ComputerShot[]): ComputerShot | undefined {
  return shots.reduce<ComputerShot | undefined>((newest, shot) => (!newest || Date.parse(shot.takenAt) > Date.parse(newest.takenAt) ? shot : newest), undefined);
}

export function BrowserPanel({ projectId, taskId }: BrowserPanelProps) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [urls, setUrls] = useState<Partial<Record<BrowserTarget, string>>>({});
  const [activity, setActivity] = useState<Activity | null>(null);
  const [tabs, setTabs] = useState<TabsByBrowser>({});
  const [streaming, setStreaming] = useState<BrowserTarget[]>([]);
  const [framed, setFramed] = useState<BrowserTarget[]>([]);
  /** Browsers the agent closed. They open again on its next call to them. */
  const [closed, setClosed] = useState<BrowserTarget[]>([]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pick, setPick] = useState<BrowserPick | null>(null);
  const [error, setError] = useState("");
  const [shots, setShots] = useState<ComputerShot[]>([]);
  /** The Session whose computer tab is on screen. A new screenshot brings its tab up; a browser tab takes it away. */
  const [computerChat, setComputerChat] = useState<string | null>(null);
  const [lastShot, setLastShot] = useState<string | null>(null);
  /** Tabs in the user's own browser the agent has been on: the ones listed. */
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  /** Tabs the user closed in the panel. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const framesRef = useRef<Partial<Record<BrowserTarget, string>>>({});
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const socketsRef = useRef<Partial<Record<BrowserTarget, WebSocket>>>({});
  const viewportWidthsRef = useRef<Partial<Record<BrowserTarget, number>>>({});
  const shownRef = useRef<BrowserTarget | null>(null);
  const composingRef = useRef(false);
  const inputMethodKeysRef = useRef(new Set<string>());
  const lastMoveRef = useRef(0);

  const active = status?.active ?? false;
  const agentOn = status?.target ?? null;
  const browsers = useMemo(() => status?.connected ?? [], [status?.connected]);
  const target = shownBrowser(pick, browsers, agentOn);
  const rows = tabRows(tabs, browsers, target, agentOn, used, hidden);
  const url = target ? urls[target] ?? "" : "";
  const connected = target ? streaming.includes(target) : false;
  const hasFrame = target ? framed.includes(target) : false;
  const browserClosed = target ? closed.includes(target) : false;
  const newest = newestShot(shots);
  const newestKey = newest ? `${newest.chatId}@${newest.takenAt}` : null;
  if (newestKey !== lastShot) {
    setLastShot(newestKey);
    if (newest) setComputerChat(newest.chatId);
  }
  const shownShot = shots.find((shot) => shot.chatId === computerChat) ?? (!active ? newest : undefined);
  const showComputer = Boolean(shownShot);
  const screenshotUrl = useSignedUrl(shownShot ? computerScreenshotPath(projectId, taskId, shownShot) : null);
  const hasView = active || shots.length > 0;
  // Nothing left to show ends full view, so the next one opens in the panel.
  if (expanded && status && !hasView) setExpanded(false);
  const fullView = expanded && hasView;
  const watching = visible || fullView;
  const streamList = browsers.join(",");

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void getBrowserStatus(projectId, taskId)
        .then((next) => { if (alive) setStatus(next); })
        .catch(() => {});
      void getComputerShots(projectId, taskId)
        .then((next) => { if (alive) setShots(next); })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [projectId, taskId]);

  // The stream costs CPU only while someone is watching, so a hidden panel
  // disconnects rather than leaving it running behind another tab.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || fullView) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(root);
    return () => observer.disconnect();
  }, [fullView]);

  // Full view moves the panel to the document body, which remounts the image,
  // and a still page may send no new frame to fill it.
  const attachImage = useCallback((image: HTMLImageElement | null) => {
    imageRef.current = image;
    const frame = shownRef.current ? framesRef.current[shownRef.current] : undefined;
    if (image && frame) image.src = frame;
  }, []);

  const handleMessage = useCallback((from: BrowserTarget, message: StreamMessage) => {
    const onScreen = from === shownRef.current;
    switch (message.type) {
      case "frame": {
        if (typeof message.data !== "string") break;
        const frame = `data:image/jpeg;base64,${message.data}`;
        framesRef.current[from] = frame;
        if (onScreen && imageRef.current) imageRef.current.src = frame;
        if (message.metadata?.deviceWidth) viewportWidthsRef.current[from] = message.metadata.deviceWidth;
        setFramed((current) => (current.includes(from) ? current : [...current, from]));
        setClosed((current) => current.filter((item) => item !== from));
        break;
      }
      case "status":
        if (message.viewportWidth) viewportWidthsRef.current[from] = message.viewportWidth;
        // A closed browser has no page left, so its last frame and tabs go too.
        if (message.connected === false) {
          delete framesRef.current[from];
          if (onScreen && imageRef.current) imageRef.current.removeAttribute("src");
          setFramed((current) => current.filter((item) => item !== from));
          setTabs((current) => ({ ...current, [from]: [] }));
          setClosed((current) => (current.includes(from) ? current : [...current, from]));
        } else if (message.connected) {
          setClosed((current) => current.filter((item) => item !== from));
        }
        break;
      case "url":
        setUrls((current) => ({ ...current, [from]: message.url ?? "" }));
        break;
      case "tabs":
        setTabs((current) => ({ ...current, [from]: message.tabs ?? [] }));
        {
          const onTab = message.tabs?.find((tab) => tab.active);
          if (onTab) {
            const key = tabKey(from, onTab);
            setUsed((current) => (current.has(key) ? current : new Set(current).add(key)));
          }
        }
        break;
      case "command":
        if (!onScreen || BOOKKEEPING_ACTIONS.has(message.action ?? "")) break;
        setActivity({
          id: message.id ?? crypto.randomUUID(),
          label: describeCommand(message.action ?? "action", message.params),
          state: "running",
        });
        break;
      case "result":
        setActivity((current) =>
          // The driver's `success` flag is false even for calls that worked;
          // a failed call is the one that returned no data.
          current && current.id === message.id ? { ...current, state: message.data ? "done" : "failed" } : current,
        );
        break;
    }
  }, []);

  // One stream per connected browser, so the tab list always covers both. Only
  // the browser on screen runs at full rate.
  useEffect(() => {
    if (!streamList || !watching) return;
    let closed = false;
    const sockets = socketsRef.current;
    const retries = new Set<number>();
    const connect = async (from: BrowserTarget) => {
      const streamUrl = await browserStreamUrl(projectId, taskId, from).catch(() => null);
      if (closed || !streamUrl) return;
      const socket = new WebSocket(streamUrl);
      sockets[from] = socket;
      socket.onopen = () => {
        setStreaming((current) => (current.includes(from) ? current : [...current, from]));
        socket.send(JSON.stringify({ type: "config", maxFps: from === shownRef.current ? MAX_FPS : BACKGROUND_FPS }));
      };
      socket.onmessage = (event) => {
        try {
          handleMessage(from, JSON.parse(event.data as string) as StreamMessage);
        } catch {
          // A message this version does not understand is not worth failing on.
        }
      };
      socket.onclose = () => {
        setStreaming((current) => current.filter((item) => item !== from));
        if (sockets[from] === socket) delete sockets[from];
        if (!closed) retries.add(window.setTimeout(() => void connect(from), RECONNECT_MS));
      };
    };
    for (const from of streamList.split(",") as BrowserTarget[]) void connect(from);
    return () => {
      closed = true;
      retries.forEach((retry) => window.clearTimeout(retry));
      for (const socket of Object.values(sockets)) socket?.close();
      socketsRef.current = {};
      setStreaming([]);
    };
  }, [streamList, watching, projectId, taskId, handleMessage]);

  // Tabs and frames belong to one Task.
  useEffect(() => () => {
    framesRef.current = {};
    setTabs({});
    setFramed([]);
    setClosed([]);
    setUrls({});
    setActivity(null);
  }, [projectId, taskId]);

  // Moving to the other browser shows its last frame at once.
  useEffect(() => {
    shownRef.current = target;
    const frame = target ? framesRef.current[target] : undefined;
    if (frame && imageRef.current) imageRef.current.src = frame;
    for (const [from, socket] of Object.entries(socketsRef.current)) {
      if (socket?.readyState !== WebSocket.OPEN) continue;
      socket.send(JSON.stringify({ type: "config", maxFps: from === target ? MAX_FPS : BACKGROUND_FPS }));
    }
  }, [target]);

  // Once the user is typing in the page, Escape belongs to the page.
  useEffect(() => {
    if (!fullView) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && document.activeElement !== keyboardRef.current) setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullView]);

  useEffect(() => {
    if (!activity || activity.state === "running") return;
    const timer = window.setTimeout(() => setActivity(null), ACTIVITY_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [activity]);

  const run = useCallback(async (action: () => Promise<BrowserStatus>) => {
    setBusy(true);
    setError("");
    try {
      setStatus(await action());
    } catch (cause) {
      // API failures arrive as plain objects, not Errors.
      setError((cause as { message?: string } | null)?.message || "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const send = (message: object) => {
    const socket = target ? socketsRef.current[target] : undefined;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const image = imageRef.current;
    const frame = { width: image?.naturalWidth ?? 0, height: image?.naturalHeight ?? 0 };
    const box = fitFrame(rect, frame);
    // Frames from the user's own browser are the page's size; the driver's
    // reported width is only right for the browser it launched.
    const viewportWidth = target === "managed" ? viewportWidthsRef.current.managed || 0 : 0;
    return toPagePoint(event.clientX - rect.left, event.clientY - rect.top, box, pageSize(viewportWidth, frame));
  };

  const sendMouse = (eventType: string, event: MouseEvent<HTMLDivElement>) => {
    const point = pagePoint(event);
    if (!point) return;
    send({ type: "input_mouse", eventType, ...point, button: mouseButton(event.button), clickCount: event.detail || 1 });
  };

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    keyboardRef.current?.focus();
    const point = pagePoint(event);
    if (point) send({ type: "input_mouse", eventType: "mouseMoved", ...point });
    sendMouse("mousePressed", event);
  };

  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const now = performance.now();
    if (now - lastMoveRef.current < MOUSE_MOVE_INTERVAL_MS) return;
    lastMoveRef.current = now;
    const point = pagePoint(event);
    if (point) send({ type: "input_mouse", eventType: "mouseMoved", ...point });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const point = pagePoint(event);
    if (point) send({ type: "input_mouse", eventType: "mouseWheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const sendKey = (eventType: "keyDown" | "keyUp", event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys pressed while composing belong to the input method, and so does
    // their release, even once composition has ended.
    const inputMethodKeys = inputMethodKeysRef.current;
    if (eventType === "keyDown" && (composingRef.current || isInputMethodKey(event.nativeEvent))) {
      inputMethodKeys.add(event.code);
      return;
    }
    if (eventType === "keyUp" && (inputMethodKeys.delete(event.code) || composingRef.current)) return;
    event.preventDefault();
    const text = eventType === "keyDown" ? keyText(event) : undefined;
    send({
      type: "input_keyboard",
      eventType,
      key: event.key,
      code: event.code,
      modifiers: modifierBits(event),
      ...(text ? { text } : {}),
    });
  };

  const typeText = (text: string) => {
    for (const key of textToKeys(text)) send({ type: "input_keyboard", eventType: "char", text: key });
  };

  const managed = target === "managed";
  const label = shownShot ? `Computer · ${shownShot.title}` : managed ? "Test browser" : target === "personal" ? "Your browser" : undefined;
  const headerText = shownShot ? label : browserClosed ? undefined : url || label;

  const selectTab = ({ target: browser, tab }: TabRow) => {
    setComputerChat(null);
    setPick({ target: browser, agentOn });
    if (!tab.active) void run(() => switchBrowserTab(projectId, taskId, browser, tab.tabId));
  };

  const closeComputer = async (chatId: string) => {
    setBusy(true);
    setError("");
    try {
      setShots(await closeComputerTab(projectId, taskId, chatId));
    } catch (cause) {
      setError((cause as { message?: string } | null)?.message || "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const closeTab = (row: TabRow) => {
    setHidden((current) => new Set(current).add(tabKey(row.target, row.tab)));
  };

  const controls = (
    <Button
      variant="secondary"
      onClick={() => setExpanded(!fullView)}
      aria-label={fullView ? "Exit full view" : "Full view"}
      title={fullView ? "Exit full view" : "Full view"}
    >
      {fullView ? <Minimize2 /> : <Maximize2 />}
    </Button>
  );

  const panel = (
    <div ref={rootRef} className={`browser-panel${fullView ? " orbit-ui is-expanded" : ""}`}>
      <PanelHeaderContext>{headerText}</PanelHeaderContext>
      {hasView && !fullView ? <PanelHeaderActions>{controls}</PanelHeaderActions> : null}
      {fullView ? (
        <div
          className={`browser-expanded-bar${hasMacWindowControls ? " has-mac-controls" : ""}`}
          data-tauri-drag-region="deep"
          data-window-drag-strip
        >
          <span title={showComputer ? undefined : url}>{headerText}</span>
          {controls}
        </div>
      ) : null}

      {error ? <p className="browser-error" role="alert">{error}</p> : null}

      {rows.length > 0 || shots.length > 0 ? (
        <div className="browser-tabs">
          <div className="browser-tab-list" role="tablist" aria-label="Tabs the agent can use">
            {shots.map((shot) => {
              const shown = shot.chatId === shownShot?.chatId;
              return (
                <div key={shot.chatId} className={`browser-tab is-computer${shown ? " is-shown" : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shown}
                    title={`${shot.title}: latest screenshot of your computer, taken ${new Date(shot.takenAt).toLocaleTimeString()}`}
                    onClick={() => setComputerChat(shot.chatId)}
                  >
                    <Monitor className="browser-tab-icon" aria-hidden />
                    <span>{shot.title}</span>
                    <small>{new Date(shot.takenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${shot.title}`}
                    title="Close"
                    disabled={busy}
                    onClick={() => void closeComputer(shot.chatId)}
                  >
                    <X />
                  </button>
                </div>
              );
            })}
            {shots.length > 0 && rows.length > 0 ? <span className="browser-tab-divider" aria-hidden /> : null}
            {rows.map((row) => {
              const yours = row.target === "personal";
              return (
                <div key={tabKey(row.target, row.tab)} className={`browser-tab${row.shown && !showComputer ? " is-shown" : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={row.shown && !showComputer}
                    disabled={busy}
                    title={row.tab.active ? row.tab.url : "Show this tab. The agent moves here too."}
                    onClick={() => selectTab(row)}
                  >
                    <Globe className="browser-tab-icon" aria-hidden />
                    {row.agentHere ? <i className="browser-tab-agent" title="The agent is on this tab" /> : null}
                    <span>{row.tab.title || row.tab.url || row.tab.tabId}</span>
                    {yours ? <em title="In your browser, with your logins">Yours</em> : null}
                  </button>
                  <button
                    type="button"
                    aria-label="Close"
                    title="Close"
                    onClick={() => closeTab(row)}
                  >
                    <X />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {showComputer ? (
        <div className="browser-stage">
          {screenshotUrl ? <img src={screenshotUrl} alt="The agent's latest screenshot of your computer" draggable={false} /> : null}
        </div>
      ) : !active || browserClosed ? (
        <PanelEmpty icon={Globe} title="Nothing to show yet">
          Pages an agent opens show up here, and so does the latest screenshot it takes of your computer.
        </PanelEmpty>
      ) : (
        <div
          ref={stageRef}
          className="browser-stage"
          onMouseDown={onMouseDown}
          onMouseUp={(event) => sendMouse("mouseReleased", event)}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
        >
          <img ref={attachImage} alt="" hidden={!hasFrame} draggable={false} />
          {!hasFrame ? <p className="browser-waiting">{connected ? "Waiting for the page…" : "Connecting…"}</p> : null}
          <textarea
            ref={keyboardRef}
            className="browser-keyboard"
            aria-label="Type into the page"
            onKeyDown={(event) => sendKey("keyDown", event)}
            onKeyUp={(event) => sendKey("keyUp", event)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              typeText(event.data);
              event.currentTarget.value = "";
            }}
            onPaste={(event) => {
              event.preventDefault();
              typeText(event.clipboardData.getData("text"));
            }}
            onChange={(event) => {
              // Text that arrives without key presses: dictation, the emoji
              // picker. Ordinary typing never gets here.
              if (composingRef.current) return;
              typeText(event.currentTarget.value);
              event.currentTarget.value = "";
            }}
          />
          {activity ? <p className={`browser-activity is-${activity.state}`} role="status">{activity.label}</p> : null}
        </div>
      )}
    </div>
  );

  // Panels sit inside transforms and stacking contexts that would trap a fixed
  // element, so full view has to leave them.
  return fullView ? createPortal(panel, document.body) : panel;
}
