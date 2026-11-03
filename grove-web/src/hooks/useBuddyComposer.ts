import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Buddy } from "../api/buddies";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "../api/buddies.mock";
import { getChatSocket, sendSessionInput, subscribeChatSockets } from "../api/chatSockets";
import { uploadChatAttachment } from "../api/tasks";
import type { PromptCapabilities } from "../api/buddySessionConnection";
import { prepareFileAttachment, type Attachment } from "../components/Tasks/TaskView/chatAttachments";
import { sentPops } from "../components/Tasks/TaskView/conversation/sentPop";

function fileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Could not read attachment")); reader.readAsDataURL(file);
  });
}
/** Whether a prepared image/audio block can go inline; unknown capabilities are treated as supported. */
function inlineAllowed(type: Attachment["type"], caps: PromptCapabilities | null | undefined): boolean {
  if (type === "resource") return false;
  return !caps || caps[type];
}
export function useBuddyComposer(buddy: Buddy, onSent: () => void, caps?: PromptCapabilities | null) {
  const socket = useSyncExternalStore(subscribeChatSockets, () => getChatSocket(buddy.project_hash, buddy.local_task_id, buddy.active_session_id));
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef({ request: null as AbortController | null });
  useEffect(() => { const state = lifetime.current; return () => state.request?.abort(); }, []);
  const send = async (text: string, files: File[]) => {
    if (inFlight.current) throw new Error("A message is already being sent");
    inFlight.current = true; setSending(true);
    const controller = new AbortController(); lifetime.current.request = controller;
    try {
      if (BUDDIES_MOCK_ENABLED) { buddiesMock.sendMessage(buddy.id, text, files.map((file) => file.name)); onSent(); return; }
      if (!socket) throw new Error("Wait for the session to connect. Your draft is kept.");
      const attachments: unknown[] = [];
      for (const file of files) {
        const prepared: Omit<Attachment, "label"> = await prepareFileAttachment(file);
        if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
        if (controller.signal.aborted) throw new Error("Sending cancelled");
        if (inlineAllowed(prepared.type, caps)) attachments.push({ type: prepared.type, data: prepared.data, mime_type: prepared.mimeType, name: prepared.name });
        else {
          // Every ACP agent reads resource links, so media it can't take inline still arrives as a file it can open.
          const saved = await uploadChatAttachment(buddy.project_hash, buddy.local_task_id, buddy.active_session_id, { name: file.name, mime_type: file.type || "application/octet-stream", data: await fileData(file) });
          attachments.push({ type: "resource_link", uri: saved.uri, name: saved.name, mime_type: saved.mime_type, size: saved.size });
        }
      }
      const id = crypto.randomUUID();
      const busy = buddy.status !== "idle";
      // Orbit pops this message's bubble in when it appears (sentPop).
      sentPops.record(id, { queued: busy });
      // A Buddy message interrupts rather than waits: stop the running turn
      // first, then queue, so the message goes out as soon as the turn ends.
      // Cancel lands before the message exists, so it can only stop the old turn.
      if (busy && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
      await sendSessionInput(socket, { text, attachments, id, busy }, controller.signal);
      onSent();
    } finally { inFlight.current = false; if (!controller.signal.aborted) setSending(false); }
  };
  const stop = () => {
    if (BUDDIES_MOCK_ENABLED) { buddiesMock.stop(buddy.id); onSent(); return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Wait for the session to reconnect before stopping.");
    socket.send(JSON.stringify({ type: "cancel" }));
  };
  return { send, stop, sending, connected: BUDDIES_MOCK_ENABLED || socket !== null };
}
