import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Buddy } from "../api/buddies";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "../api/buddies.mock";
import { getChatSocket, sendSessionInput, subscribeChatSockets } from "../api/chatSockets";
import { uploadChatAttachment } from "../api/tasks";
import { prepareFileAttachment, type Attachment } from "../components/Tasks/TaskView/chatAttachments";

function fileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Could not read attachment")); reader.readAsDataURL(file);
  });
}
export function useBuddyComposer(buddy: Buddy, onSent: () => void) {
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
        if (prepared.type === "resource") {
          const saved = await uploadChatAttachment(buddy.project_hash, buddy.local_task_id, buddy.active_session_id, { name: file.name, mime_type: file.type, data: await fileData(file) });
          attachments.push({ type: "resource_link", uri: saved.uri, name: saved.name, mime_type: saved.mime_type, size: saved.size });
        } else attachments.push({ type: prepared.type, data: prepared.data, mime_type: prepared.mimeType, name: prepared.name });
      }
      await sendSessionInput(socket, { text, attachments, id: crypto.randomUUID(), busy: buddy.status !== "idle" }, controller.signal);
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
