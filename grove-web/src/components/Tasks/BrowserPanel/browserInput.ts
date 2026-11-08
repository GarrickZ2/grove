/** Translates what the user does on the live view into driver input messages. */

export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Where a frame sits inside its container when scaled to fit. */
export function fitFrame(container: Size, frame: Size): FrameBox {
  if (!frame.width || !frame.height) return { left: 0, top: 0, width: container.width, height: container.height };
  const scale = Math.min(container.width / frame.width, container.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height };
}

/**
 * The page's size in CSS pixels. The driver's reported height can differ from
 * the real viewport, so height comes from the frame actually on screen.
 */
export function pageSize(viewportWidth: number, frame: Size): Size {
  const width = viewportWidth || frame.width;
  return { width, height: frame.width ? (frame.height / frame.width) * width : 0 };
}

/** Page coordinates for a point in the container, or null outside the frame. */
export function toPagePoint(
  x: number,
  y: number,
  box: FrameBox,
  viewport: Size,
): { x: number; y: number } | null {
  const left = x - box.left;
  const top = y - box.top;
  if (left < 0 || top < 0 || left > box.width || top > box.height) return null;
  return {
    x: Math.round((left / box.width) * viewport.width),
    y: Math.round((top / box.height) * viewport.height),
  };
}

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

export function mouseButton(button: number): (typeof MOUSE_BUTTONS)[number] {
  return MOUSE_BUTTONS[button] ?? "left";
}

/** Driver modifier bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export function modifierBits(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * Whether a key press went to the input method. WebKit ends composition before
 * the Enter that confirms it, so that key only shows up as keyCode 229.
 */
export function isInputMethodKey(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** The text a key press types, if it types any. */
export function keyText(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined;
  if (event.key === "Enter") return "\r";
  return event.key.length === 1 ? event.key : undefined;
}

/**
 * Text split for delivery as key events. Chromium drops a key event carrying
 * more than three characters, which would lose any longer paste or phrase from
 * an input method, so each goes alone. Spreading keeps emoji whole.
 */
export function textToKeys(text: string): string[] {
  return [...text.replace(/\r\n?/g, "\n")].map((char) => (char === "\n" ? "\r" : char));
}

/** A readable line for the activity list. Typed text is deliberately left out. */
export function describeCommand(action: string, params: Record<string, unknown> | undefined): string {
  const subject = params?.url ?? params?.selector ?? params?.ref;
  return typeof subject === "string" ? `${action} ${subject}` : action;
}
