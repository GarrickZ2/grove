import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChats, type ChatSessionResponse } from "../../../api";
import type { RadioEventCallbacks } from "../../../hooks/useRadioEvents";
import { TaskChat } from "./TaskChat";

const mocks = vi.hoisted(() => ({
  radio: new Set<RadioEventCallbacks>(),
  project: { selectedProject: null, projects: [] },
  config: { config: null },
  preview: { drafts: [] },
  availability: { baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true },
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
