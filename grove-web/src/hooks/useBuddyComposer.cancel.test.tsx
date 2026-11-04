vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "false"));
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBuddyComposer } from "./useBuddyComposer";
import { createBuddiesMock } from "../api/buddies.mock";
import { getChatSocket, sendSessionInput } from "../api/chatSockets";
import { uploadChatAttachment } from "../api/tasks";
import type { PromptCapabilities } from "../api/buddySessionConnection";

vi.mock("../api/chatSockets", () => ({ getChatSocket: vi.fn(), subscribeChatSockets: () => () => {}, sendSessionInput: vi.fn() }));
vi.mock("../api/tasks", () => ({ uploadChatAttachment: vi.fn() }));
vi.mock("../components/Tasks/TaskView/chatAttachments", () => ({
  prepareFileAttachment: async (file: File) => file.type.startsWith("image/")
    ? { type: "image", data: "aW1n", mimeType: file.type, name: file.name }
    : { type: "resource", data: "", mimeType: file.type, name: file.name, pendingFile: file },
}));
let root: Root;
let composer: ReturnType<typeof useBuddyComposer>;
const buddy = createBuddiesMock().get("mock-release");
function Harness({ caps }: { caps?: PromptCapabilities | null }) {
  const current = useBuddyComposer(buddy, vi.fn(), caps);
  useEffect(() => { composer = current; });
  return null;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); root = createRoot(document.createElement("div")); });
afterEach(() => { act(() => root.unmount()); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it("sends the existing cancel event to the active Buddy session socket", () => {
  const send = vi.fn();
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send } as unknown as WebSocket);
  act(() => root.render(<Harness />));
  act(() => composer.stop());
  expect(getChatSocket).toHaveBeenCalledWith(buddy.project_hash, buddy.local_task_id, buddy.active_session_id);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "cancel" }));
});

it.each([null, WebSocket.CONNECTING, WebSocket.CLOSED])("reports an unavailable socket (%s) instead of silently ignoring cancellation", (readyState) => {
  const send = vi.fn();
  vi.mocked(getChatSocket).mockReturnValue(readyState === null ? null : { readyState, send } as unknown as WebSocket);
  act(() => root.render(<Harness />));
  expect(() => composer.stop()).toThrow("Wait for the session to reconnect before stopping.");
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ["unknown", null, "image"],
  ["supporting", { image: true, audio: false }, "image"],
  ["text-only", { image: false, audio: false }, "resource_link"],
] as const)("sends a picked image to a %s agent as %s", async (_, caps, expected) => {
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket);
  vi.mocked(uploadChatAttachment).mockResolvedValue({ uri: "file:///shot.png", name: "shot.png", mime_type: "image/png", size: 3 } as Awaited<ReturnType<typeof uploadChatAttachment>>);
  act(() => root.render(<Harness caps={caps} />));
  await act(async () => composer.send("look", [new File(["img"], "shot.png", { type: "image/png" })]));
  const input = vi.mocked(sendSessionInput).mock.calls[0][1] as { attachments: { type: string }[] };
  expect(input.attachments[0].type).toBe(expected);
  expect(uploadChatAttachment).toHaveBeenCalledTimes(expected === "image" ? 0 : 1);
});

it("interrupts a running turn before sending, and only sends while idle", async () => {
  const send = vi.fn();
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send } as unknown as WebSocket);
  let harness!: ReturnType<typeof useBuddyComposer>;
  function Busy({ status }: { status: typeof buddy.status }) {
    const current = useBuddyComposer({ ...buddy, status }, vi.fn());
    useEffect(() => { harness = current; });
    return null;
  }
  act(() => root.render(<Busy status="working" />));
  vi.mocked(sendSessionInput).mockImplementation(async () => { expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "cancel" })); });
  await act(async () => harness.send("also check the staging config", []));
  expect(sendSessionInput).toHaveBeenCalledOnce();
  expect(vi.mocked(sendSessionInput).mock.calls[0][1]).toMatchObject({ busy: true });
  send.mockClear(); vi.mocked(sendSessionInput).mockResolvedValue(undefined);
  act(() => root.render(<Busy status="idle" />));
  await act(async () => harness.send("next", []));
  expect(send).not.toHaveBeenCalled();
});

it("sends on an HTTP LAN origin, where randomUUID doesn't exist", async () => {
  vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes });
  vi.mocked(getChatSocket).mockReturnValue({ readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket);
  act(() => root.render(<Harness />));
  await act(async () => composer.send("are the repos clean", []));
  expect(sendSessionInput).toHaveBeenCalledOnce();
});
