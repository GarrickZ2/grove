import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChats, type ChatSessionResponse } from "../../../api";
import type { RadioEventCallbacks } from "../../../hooks/useRadioEvents";
import type { BottomOriginTurnListHandle } from "./BottomOriginTurnList";
import { TaskChat } from "./TaskChat";
import { OrbitInterfaceContext } from "../../../orbit/ui/interfaceContext";
import { beginGroveFileDrag } from "../../../utils/groveFileDrag";

const mocks = vi.hoisted(() => ({
  radio: new Set<RadioEventCallbacks>(),
  project: { selectedProject: null, projects: [] },
  config: { config: null },
  preview: { drafts: [] },
  availability: { baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true },
  hideTurnRows: false,
  forceVirtualization: false,
  remoteSession: false,
  virtualizationListeners: new Set<() => void>(),
}));

vi.mock("../../../api", () => ({
  listChats: vi.fn(),
  listArchivedChats: vi.fn(async () => []),
  getChatHistory: vi.fn(async () => ({ events: [], total: 0, session: null })),
  getConfig: vi.fn(async () => ({ layout: { agent_command: "" } })),
  getTaskFiles: vi.fn(async () => ({ files: [] })),
  listSpeakingProfiles: vi.fn(async () => []),
  getMentionCandidates: vi.fn(async () => ({ outgoing: [], pending_replies: [] })),
}));
vi.mock("../../../api/client", () => ({ getApiHost: () => "localhost", appendHmacToUrl: async (url: string) => url }));
vi.mock("../../../api/extension", () => ({ getExtensionStatus: async () => false }));
vi.mock("../../../context/ProjectContext", () => ({ useProject: () => mocks.project }));
vi.mock("../../../context/ConfigContext", () => ({ useConfig: () => mocks.config }));
vi.mock("../../../context/ThemeContext", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("../../../context", () => ({ usePreviewComments: () => mocks.preview }));
vi.mock("../../../hooks", () => ({
  useRadioEvents: (callbacks: RadioEventCallbacks) => {
    useEffect(() => {
      mocks.radio.add(callbacks);
      return () => { mocks.radio.delete(callbacks); };
    }, [callbacks]);
    return { radioClients: 0 };
  },
  useAgentQuota: () => ({ usage: null }),
}));
vi.mock("../../../hooks/useIsMobile", () => ({ useIsMobile: () => ({ isMobile: false, isTablet: false }) }));
vi.mock("../../../keyboard", () => ({
  useCommand: () => {}, useContextKey: () => {}, useVoiceControlContext: () => {},
  useKeyboardScope: () => {}, useDefineCommand: () => {},
}));
vi.mock("./useACPAvailability", () => ({ useACPAvailability: () => mocks.availability }));
vi.mock("./useProjectMentions", () => ({ useProjectMentions: () => ({ projects: [], contents: [] }) }));
vi.mock("../../../utils/agentIcon", () => {
  const Icon = () => null;
  return {
    usePersonaRegistry: () => {}, resolveAgentIcon: () => ({ label: "Agent", Component: Icon }),
    agentIconComponent: () => Icon, agentIconUrl: () => null,
  };
});
vi.mock("../../ui", () => ({
  Button: "button", ImageLightbox: () => null, MarkdownRenderer: () => null,
  VSCodeIcon: () => null, FileMentionDropdown: () => null,
  AgentPickerMenuItems: () => null, DropdownMenu: () => null,
}));
vi.mock("../TaskDetail/XTerminal", () => ({ XTerminal: () => null }));
vi.mock("../../Dialogs/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./taskChatVirtualScroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./taskChatVirtualScroll")>();
  return { ...actual, shouldVirtualizeTaskChat: (count: number, limit: number) => mocks.forceVirtualization || actual.shouldVirtualizeTaskChat(count, limit) };
});
vi.mock("./BottomOriginTurnList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BottomOriginTurnList")>();
  const { forwardRef, useSyncExternalStore } = await import("react");
  type Props = React.ComponentProps<typeof actual.BottomOriginTurnList>;
  return {
    ...actual,
    BottomOriginTurnList: forwardRef<BottomOriginTurnListHandle, Props>(function RemountableTurnList(props, ref) {
      const hidden = useSyncExternalStore((listener) => {
        mocks.virtualizationListeners.add(listener);
        return () => { mocks.virtualizationListeners.delete(listener); };
      }, () => mocks.hideTurnRows);
      return <actual.BottomOriginTurnList {...props} ref={ref} renderTurn={(turn) => hidden ? null : props.renderTurn(turn)} />;
    }),
  };
});

const chatA: ChatSessionResponse = {
  id: "A", title: "Session A", agent: "test", created_at: "2026-10-30T00:00:00Z",
  history_path: "", launch_mode: "acp",
};
const chatB = { ...chatA, id: "B", title: "Session B" };
const win = window as unknown as { __grove_pending_chat?: { projectId: string; taskId: string; chatId: string } };

class ChatSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = new Map<string, ChatSocket>();
  readyState = ChatSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  send = vi.fn((data: string) => { this.sent.push(data); });

  constructor(url: string) {
    super();
    const chatId = new URL(url).pathname.split("/").at(-2)!;
    ChatSocket.instances.set(chatId, this);
    queueMicrotask(() => {
      if (mocks.remoteSession) {
        this.receive({ type: "remote_session", agent_name: "Codex" });
        this.close();
      } else this.receive({ type: "session_ready" });
    });
  }

  receive(data: object) {
    const event = new MessageEvent("message", { data: JSON.stringify(data) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close() {
    this.readyState = ChatSocket.CLOSED;
    const event = new CloseEvent("close", { code: 1000 });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}

describe("TaskChat draft isolation during session completion", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.remoteSession = false;
    mocks.hideTurnRows = false;
    mocks.forceVirtualization = false;
    mocks.virtualizationListeners.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const name of ["localStorage", "sessionStorage"]) {
      const values = new Map<string, string>();
      vi.stubGlobal(name, {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
      });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("WebSocket", ChatSocket);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    ChatSocket.instances.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
    vi.mocked(listChats).mockResolvedValue([chatA, chatB]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete win.__grove_pending_chat;
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows read only and take control after the remote owner closes the socket", async () => {
    mocks.remoteSession = true;
    await render();
    await openChat("A");
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).toContain("Take Control");
    expect(container.textContent).not.toMatch(/Connect Failed|failed to connect|Connection closed before/);
    await openChat("B");
    await openChat("A");
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).not.toMatch(/Connect Failed|failed to connect|Connection closed before/);
  });

  async function render() {
    await act(async () => root.render(<TaskChat projectId="project" taskId="task" />));
  }

  function editor() {
    const element = container.querySelector<HTMLDivElement>('[contenteditable="true"]');
    expect(element).not.toBeNull();
    return element!;
  }

  async function openChat(chatId: string, chat?: ChatSessionResponse) {
    const target = { projectId: "project", taskId: "task", chatId };
    await act(async () => {
      win.__grove_pending_chat = target;
      window.dispatchEvent(new CustomEvent("grove:switch-chat", { detail: { ...target, chat } }));
    });
  }

  function typeDraft(text: string) {
    act(() => {
      editor().textContent = text;
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function refreshChats(chats = [chatB, chatA], projectId = "project", taskId = "task") {
    vi.mocked(listChats).mockResolvedValue(chats);
    await act(async () => {
      for (const subscriber of [...mocks.radio]) subscriber.onChatListChanged?.(projectId, taskId);
    });
  }

  async function completeOtherSession() {
    // ACP Complete touches the session and publishes ChatListChanged, with
    // the completed session now ahead of A in the refreshed list.
    await act(async () => {
      const socket = ChatSocket.instances.get("B");
      expect(socket).toBeDefined();
      socket!.receive({ type: "complete", stop_reason: "end_turn" });
    });
    await refreshChats();
  }

  it("under Orbit pops the bubble of a message sent here, through the real echo sequence, and not history", async () => {
    await act(async () => root.render(<OrbitInterfaceContext.Provider value><TaskChat projectId="project" taskId="task" /></OrbitInterfaceContext.Provider>));
    const socket = ChatSocket.instances.get("A")!;
    await act(async () => {
      socket.receive({ type: "user_message", text: "Earlier", client_message_id: "history-1" });
      socket.receive({ type: "user_message_time", sent_at: Date.now() - 60_000, client_message_id: "history-1" });
      socket.receive({ type: "complete", stop_reason: "EndTurn" });
    });
    typeDraft("Pop me");
    // Enter goes through the keyboard catalog (mocked here); the orb is the same send.
    await act(async () => { container.querySelector<HTMLButtonElement>(".oc-orb.is-send")!.click(); });
    await vi.waitFor(() => expect(socket.sent.some((data) => JSON.parse(data).type === "prompt")).toBe(true));
    const prompt = socket.sent.map((data) => JSON.parse(data)).find((event) => event.type === "prompt");
    // Exactly what src/api/handlers/acp.rs emits for a prompt.
    await act(async () => {
      socket.receive({ type: "user_message", text: prompt.text, client_message_id: prompt.client_message_id });
      socket.receive({ type: "user_message_time", sent_at: prompt.sent_at, client_message_id: prompt.client_message_id });
      socket.receive({ type: "input_accepted", client_message_id: prompt.client_message_id });
      socket.receive({ type: "busy", value: true });
    });
    const bubbles = [...container.querySelectorAll<HTMLElement>(".ocv-user-bubble")];
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual(["Earlier", "Pop me"]);
    expect(bubbles[0].dataset.sentPop).toBeUndefined();
    expect(bubbles[1].dataset.sentPop).toMatch(/pop|wait|skipped|done/);
  });

  it("inserts every file of a multi-file drag as chips, in order and without repeats", async () => {
    await render();
    const data: Record<string, string> = {
      "application/x-grove-file-paths": JSON.stringify(["output/a.md", "output/b.png", "output/a.md"]),
      "application/x-grove-file-path": "output/a.md",
    };
    const dataTransfer = { types: Object.keys(data), files: [], items: [], getData: (type: string) => data[type] ?? "", dropEffect: "none" };
    const target = editor().closest(".chatbox-bubble")!;
    const fire = async (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      await act(async () => { target.dispatchEvent(event); });
    };
    // The panel that started the drag reports its size; the overlay says so.
    beginGroveFileDrag(2);
    await fire("dragover");
    expect(container.textContent).toContain("Drop 2 files");
    await fire("drop");
    expect([...editor().querySelectorAll<HTMLElement>("[data-file]")].map((chip) => chip.dataset.file)).toEqual(["output/a.md", "output/b.png"]);
    // A single-path drag (older senders) still inserts one chip.
    delete data["application/x-grove-file-paths"];
    data["application/x-grove-file-path"] = "output/c.txt";
    await fire("drop");
    expect([...editor().querySelectorAll<HTMLElement>("[data-file]")].map((chip) => chip.dataset.file)).toEqual(["output/a.md", "output/b.png", "output/c.txt"]);
  });

  it("answers a permission once and keeps the next request when a stale response errors", async () => {
    await render();
    const socket = ChatSocket.instances.get("A")!;
    const option = (name: string) => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);
    const ask = (id: string) => ({ type: "permission_request", id, title: `Use ${id}`, description: id, options: [{ option_id: `yes-${id}`, name: `Yes ${id}`, kind: "allow_once" }] });
    await act(async () => {
      socket.receive({ type: "user_message", text: "Check notes" });
      socket.receive({ type: "busy", value: true });
      socket.receive(ask("read_notes"));
    });
    await act(async () => { option("Yes read_notes")!.click(); option("Yes read_notes")!.click(); });
    const responses = socket.sent.map((data) => JSON.parse(data)).filter((event) => event.type === "permission_response");
    expect(responses).toEqual([{ type: "permission_response", id: "read_notes", option_id: "yes-read_notes" }]);
    await act(async () => {
      socket.receive({ type: "permission_response", id: "read_notes", option_id: "yes-read_notes" });
      // The backend serialises requests: the next one arrives, then the
      // error for a late duplicate response to the first.
      socket.receive(ask("memory_recall"));
      socket.receive({ type: "error", message: "Permission request read_notes is no longer pending" });
    });
    expect(option("Yes memory_recall")).toBeDefined();
    expect(container.textContent).not.toContain("Cancelled");
  });

  it("retains timeline disclosures through row unmounts and completed-summary unmounts", async () => {
    mocks.forceVirtualization = true;
    await render();
    await act(async () => {
      const socket = ChatSocket.instances.get("A")!;
      socket.receive({ type: "user_message", text: "Change files" });
      socket.receive({ type: "busy", value: true });
      socket.receive({ type: "tool_call", id: "read", name: "read_file", title: "Read", kind: "read", status: "completed", input: [{ label: "file_path", value: "src/read.ts" }] });
      for (let i = 0; i < 7; i += 1) {
        socket.receive({ type: "tool_call", id: `edit-${i}`, name: "edit_file", title: "Edit", kind: "edit", status: "completed", locations: [{ path: `src/file-${i}.ts` }], input: [{ label: "file_path", value: `src/file-${i}.ts` }], output: [], content: "@@ -1 +1 @@\n-before\n+after" });
      }
    });
    const byTitle = (title: string) => [...container.querySelectorAll<HTMLButtonElement>("button[title]")].find((button) => button.title === title)!;
    const byText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;
    const click = async (button: HTMLButtonElement) => {
      expect(button).toBeDefined();
      await act(async () => button.click());
    };
    expect(byTitle("Read 1 file")).toBeUndefined();
    expect(byTitle("src/file-6.ts")).toBeDefined();
    await click(byText("3 earlier steps"));
    expect(byTitle("Read 1 file").getAttribute("aria-expanded")).toBe("false");
    expect(byTitle("src/file-0.ts").getAttribute("aria-expanded")).toBe("false");
    expect(byTitle("src/file-6.ts")).toBeUndefined();
    await click(byText("1 more files"));
    await click(byTitle("Read 1 file"));
    await click(byTitle("read_file · src/read.ts"));
    expect(byTitle("read_file · src/read.ts").getAttribute("aria-expanded")).toBe("true");
    await click(byTitle("src/file-6.ts"));
    expect(byTitle("read_file · src/read.ts").getAttribute("aria-expanded")).toBe("false");
    const addedLine = [...container.querySelectorAll("pre span")].find((line) => line.textContent === "+after");
    expect(addedLine?.classList.contains("text-[var(--color-success)]")).toBe(true);

    const assertExpanded = () => {
      expect(byText("Show fewer").getAttribute("aria-expanded")).toBe("true");
      expect(byTitle("Read 1 file").getAttribute("aria-expanded")).toBe("true");
      expect(byTitle("src/file-6.ts").getAttribute("aria-expanded")).toBe("true");
      expect(byText("Show fewer files")).toBeDefined();
    };
    const remountRows = async () => {
      await act(async () => {
        mocks.hideTurnRows = true;
        for (const listener of mocks.virtualizationListeners) listener();
      });
      expect(byTitle("Read 1 file")).toBeUndefined();
      await act(async () => {
        mocks.hideTurnRows = false;
        for (const listener of mocks.virtualizationListeners) listener();
      });
    };
    await remountRows();
    assertExpanded();
    await act(async () => ChatSocket.instances.get("A")!.receive({ type: "complete", stop_reason: "end_turn" }));
    await click(byText("Worked"));
    assertExpanded();
    await remountRows();
    assertExpanded();
    await click(byText("Worked"));
    await vi.waitFor(async () => {
      await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      expect(byTitle("Read 1 file")).toBeUndefined();
    });
    await click(byText("Worked"));
    assertExpanded();
    await click(byText("Show fewer"));
    expect(byTitle("Read 1 file")).toBeUndefined();
    expect(byTitle("src/file-6.ts").getAttribute("aria-expanded")).toBe("true");
    await click(byText("3 earlier steps"));
    assertExpanded();
  });

  it("renders repeated shell calls with a count and abbreviated multiline text while retaining each input", async () => {
    await render();
    const command = '/bin/zsh -lc "\nfirst-command\n\nsecond-command\nthird-command"';
    await act(async () => {
      const socket = ChatSocket.instances.get("A")!;
      socket.receive({ type: "user_message", text: "Run checks" });
      socket.receive({ type: "busy", value: true });
      for (let i = 0; i < 3; i += 1) {
        socket.receive({ type: "tool_call", id: `call-${i}`, name: "exec_command", title: "Run", kind: "execute", status: i === 2 ? "running" : i === 0 ? "failed" : "completed", input: [{ label: "command", value: command }] });
        socket.receive({ type: "tool_call", id: `guardian-${i}`, name: "Guardian Review", title: "Guardian Review", kind: "think", status: "completed" });
      }
    });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button[title]")].filter((button) => button.title === command);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain("first-command");
    expect(buttons[0].textContent).toContain("+2 lines");
    expect(buttons[0].textContent).toContain("×3");
    expect(buttons[0].textContent).toContain("failed");
    expect(buttons[0].textContent).not.toContain("/bin/zsh");
    expect(buttons[0].classList.contains("text-[var(--color-error)]")).toBe(false);
    expect(buttons[0].querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
    expect(container.textContent).not.toContain("Guardian Review");
    await act(async () => buttons[0].click());
    const originalInputs = [...container.querySelectorAll("dd")].filter((field) => field.textContent === command);
    expect(originalInputs).toHaveLength(3);
  });

  it("preserves a live draft after opening an already-loaded session", async () => {
    await render();
    await openChat("B");
    await openChat("A"); // A now has an empty switch-time cached draft.
    typeDraft("正在输入，还没有发送");
    const originalEditor = editor();
    await completeOtherSession();
    expect(editor()).toBe(originalEditor);
    expect(editor().textContent).toBe("正在输入，还没有发送");
    expect(win.__grove_pending_chat).toBeUndefined();
  });

  it("consumes navigation to the current session without touching its draft or caret", async () => {
    await render();
    typeDraft("Keep this draft");
    const input = editor();
    act(() => input.focus());
    const selection = window.getSelection()!;
    selection.collapse(input.firstChild, 4);
    await openChat("A");
    expect(win.__grove_pending_chat).toBeUndefined();
    await refreshChats();
    expect(editor().textContent).toBe("Keep this draft");
    expect(document.activeElement).toBe(input);
    expect(selection.anchorNode).toBe(input.firstChild);
    expect(selection.anchorOffset).toBe(4);
  });

  it("ignores a stale pending request for the active session during completion", async () => {
    await render();
    await openChat("B");
    await openChat("A");
    typeDraft("Newer than the cached draft");
    // Also defend against a pending marker left by an earlier navigation.
    win.__grove_pending_chat = { projectId: "project", taskId: "task", chatId: "A" };
    await completeOtherSession();
    expect(editor().textContent).toBe("Newer than the cached draft");
    expect(win.__grove_pending_chat).toBeUndefined();
  });

  it("preserves drafts on ordinary completion and repeated list refreshes", async () => {
    await render();
    await openChat("B");
    await openChat("A");
    delete win.__grove_pending_chat;
    typeDraft("Unsent draft");
    await completeOtherSession();
    await refreshChats();
    expect(editor().textContent).toBe("Unsent draft");
  });

  it.each([
    ["project", "other-task"],
    ["other-project", "task"],
  ])("ignores completion refreshes from %s/%s", async (projectId, taskId) => {
    await render();
    typeDraft("Current task draft");
    const calls = vi.mocked(listChats).mock.calls.length;
    await refreshChats([chatB, chatA], projectId, taskId);
    expect(listChats).toHaveBeenCalledTimes(calls);
    expect(editor().textContent).toBe("Current task draft");
  });

  it("saves the outgoing draft when a previously unknown target becomes available", async () => {
    await render();
    await openChat("C");
    typeDraft("Keep A while waiting for C");
    await refreshChats(); // C is still missing; leave A alone.
    expect(editor().textContent).toBe("Keep A while waiting for C");
    expect(win.__grove_pending_chat?.chatId).toBe("C");
    await refreshChats([{ ...chatA, id: "C", title: "Session C" }, chatB, chatA]);
    expect(win.__grove_pending_chat).toBeUndefined();
    expect(editor().textContent).toBe("");
    await openChat("A");
    expect(editor().textContent).toBe("Keep A while waiting for C");
  });

  it("consumes an immediately available newly-created session", async () => {
    await render();
    const chatC = { ...chatA, id: "C", title: "Session C" };
    await openChat("C", chatC);
    expect(win.__grove_pending_chat).toBeUndefined();
    typeDraft("C draft");
    await refreshChats([chatB, chatC, chatA]);
    expect(editor().textContent).toBe("C draft");
  });

  it("lets a newer explicit switch supersede an unresolved pending navigation", async () => {
    await render();
    await openChat("C");
    // An ordinary session click has no new pending marker.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("grove:switch-chat", {
        detail: { projectId: "project", taskId: "task", chatId: "B" },
      }));
    });
    typeDraft("Stay in B");
    await refreshChats([{ ...chatA, id: "C", title: "Session C" }, chatB, chatA]);
    expect(editor().textContent).toBe("Stay in B");
    expect(win.__grove_pending_chat).toBeUndefined();
  });

  it("does not consume a pending navigation owned by another task", async () => {
    await render();
    const pending = { projectId: "project", taskId: "other-task", chatId: "C" };
    win.__grove_pending_chat = pending;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("grove:switch-chat", {
        detail: { projectId: "project", taskId: "task", chatId: "B" },
      }));
    });
    typeDraft("B draft");
    await refreshChats();
    expect(editor().textContent).toBe("B draft");
    expect(win.__grove_pending_chat).toBe(pending);
  });
});
