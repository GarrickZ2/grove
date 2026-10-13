/** Keep the unsent draft separate from the pending message borrowing its composer. */
export interface ComposerDraft<T> {
  html: string;
  attachments: T[];
  terminalMode: boolean;
  expanded: boolean;
  selection?: { start: number[]; startOffset: number; end: number[]; endOffset: number };
}

function nodePath(element: HTMLElement, node: Node): number[] | undefined {
  const path: number[] = [];
  while (node !== element) {
    const parent = node.parentNode;
    if (!parent) return undefined;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return path;
}

export function captureComposerDraft<T>(element: HTMLElement, attachments: T[], terminalMode: boolean, expanded: boolean): ComposerDraft<T> {
  const draft: ComposerDraft<T> = { html: element.innerHTML, attachments: [...attachments], terminalMode, expanded };
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    const start = nodePath(element, range.startContainer);
    const end = nodePath(element, range.endContainer);
    if (start && end) draft.selection = { start, startOffset: range.startOffset, end, endOffset: range.endOffset };
  }
  return draft;
}

export function restoreComposerDraft<T>(element: HTMLElement, draft: ComposerDraft<T>, focus = true): void {
  element.innerHTML = draft.html;
  if (!focus) return;
  element.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  if (draft.selection) {
    const resolve = (path: number[]) => path.reduce<Node | undefined>((node, index) => node?.childNodes[index], element);
    const start = resolve(draft.selection.start);
    const end = resolve(draft.selection.end);
    if (start && end) {
      range.setStart(start, draft.selection.startOffset);
      range.setEnd(end, draft.selection.endOffset);
    }
  }
  selection.removeAllRanges();
  selection.addRange(range);
}
