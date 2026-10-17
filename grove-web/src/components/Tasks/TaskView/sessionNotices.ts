export type SessionNoticeMessage = {
  type: "session_notice";
  severity: string;
  title: string;
  description?: string;
};

export function sessionNoticeFromEvent(event: Record<string, unknown>): SessionNoticeMessage | null {
  if (typeof event.title !== "string" || !event.title.trim()) return null;
  return {
    type: "session_notice",
    severity: typeof event.severity === "string" ? event.severity : "unknown",
    title: event.title,
    ...(typeof event.description === "string" ? { description: event.description } : {}),
  };
}

/** Notices delimit streamed text so later chunks cannot jump ahead of them. */
export function appendSessionNotice<T extends { type: string }>(
  messages: T[],
  notice: SessionNoticeMessage,
): (T | SessionNoticeMessage)[] {
  return [
    ...messages.map((message) =>
      message.type === "assistant" || message.type === "thinking"
        ? { ...message, complete: true }
        : message,
    ),
    notice,
  ];
}
