// Splits a short, conversational assistant reply into chat bubbles, one per
// paragraph, with "✓ Thing → result" paragraphs as receipts. Anything longer
// or structured (code, tables, lists, headings) reads better as one block of
// prose, so chatBubbles returns null and the reply renders as plain markdown.

export type ReceiptItem = { label: string; result?: string };
export type Bubble =
  | { kind: "text"; content: string }
  | { kind: "receipt"; items: ReceiptItem[] };

const FENCE = /^\s*(```|~~~)/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s/;
const RECEIPT = /^\s*(?:[-*+]\s+)?[✓✔]\s*(.+)$/;
const STRUCTURED = /^\s*(?:```|~~~|#{1,6}\s|\||>\s)/;
const MAX_BUBBLES = 4;
const MAX_BUBBLE_CHARS = 140;

// Agents can narrate each automatic approval decision as plain reply text, in
// varying wording. The status must be followed by details or a colon, so a
// sentence that merely mentions automatic approval review stays.
const APPROVAL_NOTE = /Automatic approval review[ \t]+\w+[ \t]*(?:\([^)\n]*\)[ \t]*:?|:)[^.!?\n]*[.!?]?[ \t]*\n*/gi;

export function withoutApprovalNotes(content: string): string {
  return content.replace(APPROVAL_NOTE, "");
}

function paragraphs(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of content.split("\n")) {
    const marker = line.match(FENCE)?.[1];
    if (fence) {
      current.push(line);
      if (marker === fence) fence = null;
    } else if (marker) {
      fence = marker;
      current.push(line);
    } else if (!line.trim()) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

const lines = (block: string) => block.split("\n").filter(line => line.trim());
const isReceipt = (block: string) => lines(block).every(line => RECEIPT.test(line));
const isList = (block: string) => LIST.test(block) || /^\s{2,}\S/.test(block);

function belongsToPrevious(prev: string, block: string): boolean {
  if (isReceipt(block)) return false;
  const last = lines(prev).at(-1) ?? "";
  if (/^#{1,6}\s/.test(prev) && lines(prev).length === 1) return true;
  if (/[:：]$/.test(last.trim()) && (isList(block) || FENCE.test(block))) return true;
  return isList(block) && lines(prev).some(line => LIST.test(line)) && (LIST.test(last) || /^\s+\S/.test(last));
}

const strong = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").trim();

function receiptItem(line: string): ReceiptItem {
  const text = line.match(RECEIPT)![1];
  const arrow = text.search(/→|->/);
  if (arrow < 0) return { label: strong(text) };
  const result = strong(text.slice(arrow).replace(/^(→|->)/, ""));
  return { label: strong(text.slice(0, arrow)), ...(result ? { result } : {}) };
}

export function splitBubbles(content: string): Bubble[] {
  const merged: string[] = [];
  for (const block of paragraphs(content)) {
    const prev = merged.at(-1);
    if (prev !== undefined && belongsToPrevious(prev, block)) merged[merged.length - 1] = `${prev}\n\n${block}`;
    else merged.push(block);
  }
  return merged.map((block): Bubble => isReceipt(block)
    ? { kind: "receipt", items: lines(block).map(receiptItem) }
    : { kind: "text", content: block });
}

export function chatBubbles(content: string): Bubble[] | null {
  const bubbles = splitBubbles(content);
  if (bubbles.length > MAX_BUBBLES) return null;
  const chatty = bubbles.every(bubble => bubble.kind === "receipt"
    || (bubble.content.length <= MAX_BUBBLE_CHARS && !lines(bubble.content).some(line => STRUCTURED.test(line) || LIST.test(line))));
  return chatty ? bubbles : null;
}
