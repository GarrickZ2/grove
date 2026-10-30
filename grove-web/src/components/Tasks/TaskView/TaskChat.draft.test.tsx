import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChats, type ChatSessionResponse } from "../../../api";
import type { RadioEventCallbacks } from "../../../hooks/useRadioEvents";
import type { BottomOriginTurnListHandle } from "./BottomOriginTurnList";
import { TaskChat } from "./TaskChat";

const mocks = vi.hoisted(() => ({
  radio: new Set<RadioEventCallbacks>(),
  project: { selectedProject: null, projects: [] },
  config: { config: null },
  preview: { drafts: [] },
  availability: { baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true },
  hideTurnRows: false,
  forceVirtualization: false,
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
  send = vi.fn();

  constructor(url: string) {
    super();
    const chatId = new URL(url).pathname.split("/").at(-2)!;
    ChatSocket.instances.set(chatId, this);
    queueMicrotask(() => this.receive({ type: "session_ready" }));
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
