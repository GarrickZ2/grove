import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import type { PreviewCommentLocator } from '../../context';
import { useDefineCommand, useKeyboardScope } from '../../keyboard';
import { rectInViewport, rectRelativeTo } from './previewCommentGeometry';

export interface MarkdownCommentMarker {
  id: string;
  label: string;
  selector?: string;
  xpath?: string;
  extraBlocks?: Array<{ selector: string; xpath: string }>;
  locator?: PreviewCommentLocator;
  comment?: string;
}

export interface MarkdownCommentConfig {
  enabled?: boolean;
  previewId: string;
  markers?: MarkdownCommentMarker[];
  onAdd?: (locator: PreviewCommentLocator, comment: string) => void;
  onUpdate?: (id: string, comment: string) => void;
  onDelete?: (id: string) => void;
}

interface ResolvedMarker {
  id: string;
  label: string;
  rects: DOMRect[];
  marker: MarkdownCommentMarker;
}

interface Props {
  previewComment?: MarkdownCommentConfig;
  children: ReactNode;
  /** Fill a bounded preview viewport. Natural-height markdown leaves this off. */
  fill?: boolean;
}

const BLOCK_TAGS = new Set([
  'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'form', 'table', 'tr', 'li', 'button', 'a', 'img', 'svg', 'canvas',
]);

const TEXT_SELECTION_ANCHOR_TAGS = new Set([
  'p', 'li', 'td', 'th', 'blockquote', 'pre', 'figcaption', 'dt', 'dd',
]);

function clean(s: string, n: number): string {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function cssEscape(v: string): string {
  if (typeof window !== 'undefined' && window.CSS && CSS.escape) return CSS.escape(v);
  return String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\0000${ch.charCodeAt(0).toString(16)} `);
}

function pathSelector(el: Element, stop: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== stop && cur.nodeType === 1) {
    let part = cur.tagName.toLowerCase();
    const cls = Array.from(cur.classList || []).filter(Boolean).slice(0, 2);
    if (cls.length) part += `.${cls.map(cssEscape).join('.')}`;
    const parentEl: Element | null = cur.parentElement;
    if (parentEl) {
      const same = Array.from(parentEl.children).filter((c: Element) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parentEl;
    if (parts.length >= 6) break;
  }
  return parts.join(' > ');
}

function xPath(el: Element, stop: Element): string {
  const segs: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== stop && cur.nodeType === 1) {
    let i = 1;
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (sib.tagName === cur.tagName) i++;
      sib = sib.previousElementSibling;
    }
    segs.unshift(`${cur.tagName.toLowerCase()}[${i}]`);
    cur = cur.parentElement;
  }
  return `/${segs.join('/')}`;
}

function describe(el: Element, stop: Element): PreviewCommentLocator {
  const r = el.getBoundingClientRect();
  const html = el as HTMLElement;
  return {
    type: 'dom',
    selector: pathSelector(el, stop),
    xpath: xPath(el, stop),
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    className: clean(typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''), 160) || undefined,
    role: el.getAttribute('role') || undefined,
    text: clean(html.innerText || el.textContent || '', 300),
    html: clean(el.outerHTML || '', 300),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

function isBlockCandidate(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (BLOCK_TAGS.has(tag)) return true;
  if (/^h[1-6]$/.test(tag) || tag === 'p') return true;
  if (tag === 'div') {
    const r = el.getBoundingClientRect();
    return r.width >= 24 && r.height >= 16;
  }
  return false;
}

const BLOCKS_BETWEEN_CAP = 200;

// Walk doc-order from `start` to `end` (inclusive), collecting block-candidate
// elements. Skips descendants of an already-included block so nested blocks
// don't double-count.
function blocksBetween(start: Element, end: Element, content: Element): Element[] {
  if (start === end) return [start];
  let first = start, last = end;
  if (start.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_PRECEDING) {
    first = end;
    last = start;
  }
  const result: Element[] = [first];
  let prev: Element = first;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = first;
  let n: Node | null = walker.nextNode();
  let steps = 0;
  while (n) {
    if (++steps > BLOCKS_BETWEEN_CAP * 8) {
      // Defensive: tree walk too long, bail with start+end only.
      return [first, last];
    }
    const el = n as Element;
    if (el === last) break;
    if (!prev.contains(el) && isBlockCandidate(el)) {
      result.push(el);
      prev = el;
      if (result.length >= BLOCKS_BETWEEN_CAP) return [first, last];
    }
    n = walker.nextNode();
  }
  if (result[result.length - 1] !== last) result.push(last);
  return result;
}

function unionRect(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  if (rects.length === 1) return rects[0];
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const rc of rects) {
    if (rc.left < l) l = rc.left;
    if (rc.top < t) t = rc.top;
    if (rc.right > r) r = rc.right;
    if (rc.bottom > b) b = rc.bottom;
  }
  return new DOMRect(l, t, r - l, b - t);
}

const SELECTION_ACTION_WIDTH = 112;
const SELECTION_ACTION_HEIGHT = 34;
const SELECTION_ACTION_GAP = 8;
const SELECTION_ACTION_EDGE = 8;

function selectionActionPosition(selection: DOMRect, host: DOMRect): { left: number; top: number } {
  const viewportLeft = Math.max(host.left + SELECTION_ACTION_EDGE, SELECTION_ACTION_EDGE);
  const viewportRight = Math.min(host.right - SELECTION_ACTION_EDGE, window.innerWidth - SELECTION_ACTION_EDGE);
  const viewportTop = Math.max(host.top + SELECTION_ACTION_EDGE, SELECTION_ACTION_EDGE);
  const viewportBottom = Math.min(host.bottom - SELECTION_ACTION_EDGE, window.innerHeight - SELECTION_ACTION_EDGE);
  const clampLeft = (left: number) => Math.max(viewportLeft, Math.min(left, viewportRight - SELECTION_ACTION_WIDTH));
  const clampTop = (top: number) => Math.max(viewportTop, Math.min(top, viewportBottom - SELECTION_ACTION_HEIGHT));

  // Prefer the ragged right-side whitespace common to multi-line selections.
  if (selection.right + SELECTION_ACTION_GAP + SELECTION_ACTION_WIDTH <= viewportRight) {
    return {
      left: selection.right + SELECTION_ACTION_GAP - host.left,
      top: clampTop(selection.bottom - SELECTION_ACTION_HEIGHT) - host.top,
    };
  }
  if (selection.bottom + SELECTION_ACTION_GAP + SELECTION_ACTION_HEIGHT <= viewportBottom) {
    return {
      left: clampLeft(selection.right - SELECTION_ACTION_WIDTH) - host.left,
      top: selection.bottom + SELECTION_ACTION_GAP - host.top,
    };
  }
  if (selection.top - SELECTION_ACTION_GAP - SELECTION_ACTION_HEIGHT >= viewportTop) {
    return {
      left: clampLeft(selection.right - SELECTION_ACTION_WIDTH) - host.left,
      top: selection.top - SELECTION_ACTION_GAP - SELECTION_ACTION_HEIGHT - host.top,
    };
  }
  if (selection.left - SELECTION_ACTION_GAP - SELECTION_ACTION_WIDTH >= viewportLeft) {
    return {
      left: selection.left - SELECTION_ACTION_GAP - SELECTION_ACTION_WIDTH - host.left,
      top: clampTop(selection.bottom - SELECTION_ACTION_HEIGHT) - host.top,
    };
  }

  // Extremely constrained viewport: keep the action visible. This fallback
  // should only be reachable when no non-overlapping side can fit it.
  return {
    left: clampLeft(selection.right - SELECTION_ACTION_WIDTH) - host.left,
    top: clampTop(selection.bottom + SELECTION_ACTION_GAP) - host.top,
  };
}

function describeBlocks(blocks: Element[], stop: Element): PreviewCommentLocator {
  const head = blocks[0];
  const r = head.getBoundingClientRect();
  const html = head as HTMLElement;
  const extras = blocks.slice(1).map((b) => ({
    selector: pathSelector(b, stop),
    xpath: xPath(b, stop),
  }));
  // Concatenate text across blocks (separated by newline) for agent context.
  const fullText = blocks
    .map((b) => clean((b as HTMLElement).innerText || b.textContent || '', 300))
    .filter(Boolean)
    .join('\n');
  return {
    type: 'dom',
    selector: pathSelector(head, stop),
    xpath: xPath(head, stop),
    tagName: head.tagName.toLowerCase(),
    id: head.id || undefined,
    className: clean(typeof head.className === 'string' ? head.className : (head.getAttribute('class') || ''), 160) || undefined,
    role: head.getAttribute('role') || undefined,
    text: clean(fullText, 600),
    html: extras.length > 0
      ? `[multi blocks=${blocks.length} first=${head.tagName.toLowerCase()}]\n${clean(html.outerHTML || '', 200)}`
      : clean(html.outerHTML || '', 300),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    extraBlocks: extras.length > 0 ? extras : undefined,
  };
}

function pickBlock(el: Element | null, stop: Element): Element | null {
  if (!el) return null;
  if (el.nodeType !== 1) {
    const parent = (el as Node).parentElement;
    if (!parent) return null;
    el = parent;
  }
  if (!stop.contains(el)) return null;
  // Ignore our own overlays
  if ((el as HTMLElement).closest('[data-grove-comment-overlay="true"]')) return null;
  let cur: Element | null = el;
  while (cur && cur !== stop) {
    const tag = cur.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag)) return cur;
    if (/^h[1-6]$/.test(tag) || tag === 'p') return cur;
    // Need rect for size-based checks below — compute lazily.
    const rect = cur.getBoundingClientRect();
    if (tag === 'div' && rect.width >= 24 && rect.height >= 16) return cur;
    // Any sized element that directly wraps text (e.g. a <span> labeled
    // "总用户数" inside a card). Without this we'd walk past the inline
    // wrapper and land on the outer container, which over-shoots intent.
    if (rect.width >= 24 && rect.height >= 16) {
      for (let i = 0; i < cur.childNodes.length; i++) {
        const c = cur.childNodes[i];
        if (c.nodeType === Node.TEXT_NODE && (c.textContent || '').trim()) return cur;
      }
    }
    cur = cur.parentElement;
  }
  return el;
}

/** Text offsets must be relative to a stable semantic block. Inline wrappers
 * generated by Markdown rendering can share selectors or be reconciled on a
 * later render, which makes an otherwise valid textRange point at a sibling. */
// eslint-disable-next-line react-refresh/only-export-components -- exported for DOM locator regression coverage
export function textSelectionAnchor(range: Range, stop: Element): Element | null {
  let cur = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  while (cur && cur !== stop) {
    const tag = cur.tagName.toLowerCase();
    if (TEXT_SELECTION_ANCHOR_TAGS.has(tag) || /^h[1-6]$/.test(tag)) return cur;
    cur = cur.parentElement;
  }
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  return pickBlock(ancestor, stop);
}

function textRangeForOffsets(element: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const next = offset + node.data.length;
    if (!startNode && start >= offset && start <= next) {
      startNode = node;
      startOffset = start - offset;
    }
    if (end >= offset && end <= next) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset = next;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** Resolve an exact text marker and verify its quote. Older drafts may point
 * at a non-unique inline wrapper; walk upward and relocate by quote so those
 * comments repair themselves without being deleted and recreated. */
// eslint-disable-next-line react-refresh/only-export-components -- exported for legacy locator recovery coverage
export function textRangeForLocator(
  element: Element,
  locator: PreviewCommentLocator,
  stop: Element,
): Range | null {
  const textRange = locator.textRange;
  if (!textRange) return null;
  const direct = textRangeForOffsets(element, textRange.start, textRange.end);
  if (direct?.toString() === textRange.quote) return direct;

  let cur: Element | null = element;
  while (cur && stop.contains(cur)) {
    const offset = (cur.textContent ?? '').indexOf(textRange.quote);
    if (offset >= 0) {
      const recovered = textRangeForOffsets(cur, offset, offset + textRange.quote.length);
      if (recovered?.toString() === textRange.quote) return recovered;
    }
    if (cur === stop) break;
    cur = cur.parentElement;
  }
  return null;
}

export function PreviewCommentHost({ previewComment, children, fill = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hoverRects, setHoverRects] = useState<DOMRect[]>([]);
  const [markerRects, setMarkerRects] = useState<ResolvedMarker[]>([]);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);
  const [selectionAction, setSelectionAction] = useState<{
    locator: PreviewCommentLocator;
    rect: DOMRect;
    range: Range;
  } | null>(null);
  const [editor, setEditor] = useState<{
    locator: PreviewCommentLocator;
    rect: DOMRect;
    markerId?: string;
    text: string;
    range?: Range;
  } | null>(null);

  const enabled = !!previewComment?.enabled;
  const previewId = previewComment?.previewId;
  const onAdd = previewComment?.onAdd;

  const markersKey = useMemo(
    () => JSON.stringify(previewComment?.markers ?? []),
    [previewComment?.markers],
  );

  // Keep an exact, independent highlight while focus moves into the editor.
  // Native selection styling disappears as soon as the textarea receives
  // focus, so it cannot communicate what the pending comment targets.
  useEffect(() => {
    if (!editor?.range || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    const highlightName = `grove-markdown-comment-pending-${previewId}`;
    const styleId = `${highlightName}-style`;
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      style.textContent = `::highlight(${highlightName}){background:color-mix(in srgb,var(--color-highlight) 32%,transparent);color:inherit;}`;
      document.head.appendChild(style);
    }
    try { CSS.highlights.set(highlightName, new Highlight(editor.range)); } catch { /* noop */ }
    return () => {
      try { CSS.highlights.delete(highlightName); } catch { /* noop */ }
      style?.remove();
    };
  }, [editor?.range, previewId]);

  // Keep hostRect fresh (for absolute overlay positioning relative to host).
  // ResizeObserver does not fire when an ancestor moves via transform. File
  // previews enter with a Framer Motion transform, so caching the rect during
  // that animation made comment overlays intermittently retain an off-screen
  // origin. Observe ancestor style/class mutations as well and sample the
  // final viewport rect on the next animation frame.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const next = host.getBoundingClientRect();
      setHostRect((current) => (
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next
      ));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };
    update();
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    const ancestorMotionObserver = new MutationObserver(schedule);
    let ancestor = host.parentElement;
    while (ancestor) {
      ancestorMotionObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      ro.disconnect();
      ancestorMotionObserver.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Drag state lives in a ref so both the mouse-listener effect (which
  // mutates startBlock / lastBlocks) and the Escape command handler
  // (which has to reset them) share the same instance without re-running
  // the effect whenever drag state changes.
  const dragStateRef = useRef<{ startBlock: Element | null; lastBlocks: Element[] }>({
    startBlock: null,
    lastBlocks: [],
  });

  // Comment mode listeners
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !enabled || !previewId) return;

    const drag = dragStateRef.current;

    const resetDrag = () => {
      drag.startBlock = null;
      drag.lastBlocks = [];
    };

    const onMouseDown = (e: MouseEvent) => {
      const el = pickBlock(e.target as Element, content);
      if (!el) return;
      // Starting a new block target supersedes any old marker editor or
      // pending native-text action. Only one comment target may be active.
      setEditor(null);
      setSelectionAction(null);
      // Comment mode owns this gesture; do not paint a native text selection
      // underneath the block picker.
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      drag.startBlock = el;
      drag.lastBlocks = [el];
      setHoverRects([el.getBoundingClientRect()]);
    };

    const onMouseMove = (e: MouseEvent) => {
      // Defensive: if button is released and we still think we're dragging
      // (mouseup was missed because it fired outside this listener), reset.
      if (drag.startBlock && e.buttons === 0) resetDrag();
      const el = pickBlock(e.target as Element, content);
      if (!el) {
        if (!drag.startBlock) setHoverRects([]);
        return;
      }
      if (drag.startBlock) {
        const blocks = blocksBetween(drag.startBlock, el, content);
        drag.lastBlocks = blocks;
        setHoverRects(blocks.map((b) => b.getBoundingClientRect()));
      } else {
        drag.lastBlocks = [el];
        setHoverRects([el.getBoundingClientRect()]);
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      // Window-level safety net: if the release happened outside content,
      // just clear drag state. Never preventDefault/stopPropagation/post —
      // doing so would swallow unrelated clicks on the page and inject a
      // phantom comment from whatever was last hovered.
      if (!content.contains(e.target as Node)) {
        resetDrag();
        return;
      }
      let blocks = drag.lastBlocks;
      if (blocks.length === 0) {
        const el = pickBlock(e.target as Element, content);
        if (!el) { resetDrag(); return; }
        blocks = [el];
      }
      resetDrag();
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      const payload = blocks.length === 1
        ? describe(blocks[0], content)
        : describeBlocks(blocks, content);
      const rect = unionRect(blocks.map((block) => block.getBoundingClientRect()));
      if (onAdd && rect) {
        setEditor({ locator: payload, rect, text: '' });
      } else {
        window.postMessage({
          type: 'grove-preview-comment:selected',
          previewId,
          payload,
        }, '*');
      }
    };

    const onMouseLeave = (e: MouseEvent) => {
      // If button isn't held, force-reset; matches behavior when mouseup
      // fires outside the listener target.
      if (e.buttons === 0) {
        resetDrag();
        setHoverRects([]);
      } else if (!drag.startBlock) {
        setHoverRects([]);
      }
    };

    content.addEventListener('mousedown', onMouseDown, true);
    content.addEventListener('mousemove', onMouseMove, true);
    content.addEventListener('mouseup', onMouseUp, true);
    content.addEventListener('mouseleave', onMouseLeave, true);
    window.addEventListener('mouseup', onMouseUp, true);
    content.style.cursor = 'crosshair';

    return () => {
      content.removeEventListener('mousedown', onMouseDown, true);
      content.removeEventListener('mousemove', onMouseMove, true);
      content.removeEventListener('mouseup', onMouseUp, true);
      content.removeEventListener('mouseleave', onMouseLeave, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      content.style.cursor = '';
      setHoverRects([]);
    };
  }, [enabled, previewId, onAdd]);

  // Native text selection is available even when block comment mode is off.
  // Keep the browser selection intact and offer a small contextual action;
  // choosing it feeds the same draft flow as element comments.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !previewId) return;

    const updateSelectionAction = () => {
      if (enabled) {
        setSelectionAction(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionAction(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) {
        setSelectionAction(null);
        return;
      }
      const text = clean(selection.toString(), 1200);
      const clientRects = Array.from(range.getClientRects()).filter((item) => item.width > 0 && item.height > 0);
      const rect = unionRect(clientRects) ?? range.getBoundingClientRect();
      if (!text || rect.width <= 0 || rect.height <= 0) {
        setSelectionAction(null);
        return;
      }
      const block = textSelectionAnchor(range, content);
      if (!block) {
        setSelectionAction(null);
        return;
      }
      const prefix = document.createRange();
      prefix.selectNodeContents(block);
      prefix.setEnd(range.startContainer, range.startOffset);
      const rawSelection = selection.toString();
      const startOffset = prefix.toString().length;
      // A fresh native selection is a new comment target. Do not leave an
      // existing marker editor open — its Delete action would misleadingly
      // appear to belong to the newly highlighted text.
      setEditor(null);
      setSelectionAction({
        locator: {
          ...describe(block, content),
          text,
          html: `[text selection] ${text}`,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          textRange: {
            start: startOffset,
            end: startOffset + rawSelection.length,
            quote: text,
          },
        },
        rect,
        range: range.cloneRange(),
      });
    };

    const clearOnPointerDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[data-grove-selection-action="true"]')) return;
      setSelectionAction(null);
    };

    content.addEventListener('mouseup', updateSelectionAction);
    content.addEventListener('keyup', updateSelectionAction);
    document.addEventListener('mousedown', clearOnPointerDown, true);
    return () => {
      content.removeEventListener('mouseup', updateSelectionAction);
      content.removeEventListener('keyup', updateSelectionAction);
      document.removeEventListener('mousedown', clearOnPointerDown, true);
    };
  }, [enabled, previewId]);

  // Comment-mode Escape via Scoped Command Registry. Scope is active only
  // while comment-mode is on; sits at the top of the stack and wins over
  // the host's outer preview.commentMode scope when both are pushed.
  useKeyboardScope('commentMode', enabled);
  useDefineCommand({
    id: 'preview.commentMode.exit',
    name: 'Exit Preview Comment Mode',
    category: 'File Preview',
    description: 'Cancel the in-flight preview comment selection',
    defaultBindings: [{ key: 'Escape' }],
    scope: 'commentMode',
    handler: () => {
      const drag = dragStateRef.current;
      drag.startBlock = null;
      drag.lastBlocks = [];
      setHoverRects([]);
      if (previewId) {
        window.postMessage({ type: 'grove-preview-comment:cancel', previewId }, '*');
      }
    },
  }, [previewId]);

  // Resolve marker bounding rects + reposition on layout changes
  useEffect(() => {
    const content = contentRef.current;
    const host = hostRef.current;
    if (!content || !host) return;
    const markers = JSON.parse(markersKey) as MarkdownCommentMarker[];

    const lookupOne = (selector?: string, xp?: string): Element | null => {
      let el: Element | null = null;
      if (selector) { try { el = content.querySelector(selector); } catch { /* noop */ } }
      if (!el && xp) {
        let r: XPathResult | null = null;
        try {
          r = document.evaluate(xp, content, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        } catch { /* noop */ }
        const node = r ? r.singleNodeValue : null;
        if (node && node.nodeType === 1) el = node as Element;
      }
      return el;
    };

    const resolveAll = (m: MarkdownCommentMarker): Element[] => {
      const head = lookupOne(m.selector, m.xpath);
      if (!head) return [];
      const out = [head];
      for (const eb of m.extraBlocks ?? []) {
        const el = lookupOne(eb.selector, eb.xpath);
        if (el) out.push(el);
      }
      return out;
    };

    const resolve = () => {
      // Marker and host must come from the same layout snapshot. Keeping raw
      // viewport marker rects and subtracting a later hostRect mixed two
      // animation frames, which made markers wrong only on initial open.
      const hostSnapshot = host.getBoundingClientRect();
      const resolved: ResolvedMarker[] = [];
      for (const m of markers) {
        const els = resolveAll(m);
        if (els.length === 0) continue;
        const exactRange = m.locator?.textRange && els[0]
          ? textRangeForLocator(els[0], m.locator, content)
          : null;
        const viewportRects = exactRange
          ? Array.from(exactRange.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
          : els.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        if (viewportRects.length > 0) {
          resolved.push({
            id: m.id,
            label: m.label,
            rects: viewportRects.map((rect) => rectRelativeTo(rect, hostSnapshot)),
            marker: m,
          });
        }
      }
      setMarkerRects(resolved);
    };

    resolve();

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        resolve();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(content);
    ro.observe(host);
    const mo = new MutationObserver(schedule);
    mo.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [markersKey]);

  return (
    <div ref={hostRef} className={`relative w-full${fill ? " h-full min-h-0" : ""}`}>
      <div ref={contentRef} className={`w-full${fill ? " h-full min-h-0" : ""}`}>
        {children}
      </div>
      {enabled && hoverRects.length > 0 && hostRect && (() => {
        const u = unionRect(hoverRects)!;
        return (
          <div
            data-grove-comment-overlay="true"
            className="pointer-events-none absolute"
            style={{
              left: u.left - hostRect.left,
              top: u.top - hostRect.top,
              width: u.width,
              height: u.height,
              border: '2px solid var(--color-highlight)',
              background: 'color-mix(in srgb, var(--color-highlight) 12%, transparent)',
              boxShadow: '0 0 0 1px rgba(255,255,255,.85), 0 0 0 4px color-mix(in srgb, var(--color-highlight) 18%, transparent)',
              zIndex: 50,
            }}
          />
        );
      })()}
      {selectionAction && hostRect && (() => {
        const position = selectionActionPosition(selectionAction.rect, hostRect);
        return (
        <button
          type="button"
          data-grove-comment-overlay="true"
          data-grove-selection-action="true"
          className="absolute z-[60] inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text)] shadow-lg transition-colors hover:bg-[var(--color-bg-secondary)]"
          style={{
            left: position.left,
            top: position.top,
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (previewComment?.onAdd) {
              setEditor({ locator: selectionAction.locator, rect: selectionAction.rect, range: selectionAction.range, text: '' });
            } else {
              window.postMessage({
                type: 'grove-preview-comment:selected',
                previewId,
                payload: selectionAction.locator,
              }, '*');
            }
            setSelectionAction(null);
          }}
        >
          <span aria-hidden="true">＋</span>
          Comment
        </button>
        );
      })()}
      {hostRect && markerRects.map(({ id, label, rects, marker }) => {
        const u = unionRect(rects)!;
        const anchor = rects[rects.length - 1] ?? u;
        return (
        <div key={id} data-grove-comment-overlay="true" className="pointer-events-none absolute" style={{ inset: 0, zIndex: 49 }}>
          {rects.map((rect, index) => (
            <div
              key={index}
              className="absolute"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                border: '1.5px dashed color-mix(in srgb, var(--color-highlight) 85%, transparent)',
                background: 'color-mix(in srgb, var(--color-highlight) 12%, transparent)',
                boxShadow: '0 0 0 1px rgba(255,255,255,.7)',
                borderRadius: 3,
              }}
            />
          ))}
          <div
            className="absolute flex items-center justify-center text-[11px] font-semibold text-white transition-transform hover:scale-110"
            style={{
              left: anchor.right + 4,
              top: anchor.top - 4,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: 'var(--color-highlight)',
              boxShadow: '0 1px 3px rgba(0,0,0,.25)',
              pointerEvents: 'auto',
              cursor: 'pointer',
            }}
            title={`Click to edit or delete comment #${label}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!previewId) return;
              // Editing a persisted marker supersedes any unsubmitted native
              // text selection, keeping the editor target unambiguous.
              window.getSelection()?.removeAllRanges();
              setSelectionAction(null);
              if (previewComment?.onUpdate && marker.locator) {
                setEditor({
                  locator: marker.locator,
                  rect: rectInViewport(anchor, hostRect),
                  markerId: id,
                  text: marker.comment ?? '',
                });
              } else {
                window.postMessage({ type: 'grove-preview-comment:marker-click', previewId, markerId: id }, '*');
              }
            }}
          >
            {label}
          </div>
        </div>
        );
      })}
      {editor && typeof document !== 'undefined' && createPortal((() => {
        const width = Math.min(280, window.innerWidth - 20);
        const left = window.innerWidth - editor.rect.right >= width + 20
          ? editor.rect.right + 12
          : Math.max(10, editor.rect.left - width - 12);
        const top = window.innerHeight - editor.rect.bottom >= 154
          ? editor.rect.bottom + 8
          : Math.max(10, editor.rect.top - 146);
        const close = () => setEditor(null);
        const save = () => {
          const value = editor.text.trim();
          if (!value) return;
          if (editor.markerId) previewComment?.onUpdate?.(editor.markerId, value);
          else previewComment?.onAdd?.(editor.locator, value);
          close();
        };
        return (
          <div
            data-grove-comment-overlay="true"
            data-hotkeys-dialog="true"
            className="fixed z-[10000] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
            style={{ left, top, width }}
          >
            <textarea
              autoFocus
              rows={3}
              value={editor.text}
              onChange={(event) => setEditor((current) => current ? { ...current, text: event.target.value } : current)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); close(); }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
              }}
              placeholder="Add a comment…"
              className="block w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs leading-4 text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div>
                {editor.markerId && previewComment?.onDelete && (
                  <button
                    type="button"
                    onClick={() => { previewComment.onDelete?.(editor.markerId!); close(); }}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)]"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={close} className="rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]">Cancel</button>
                <button type="button" disabled={!editor.text.trim()} onClick={save} className="rounded-md bg-[var(--color-highlight)] px-2.5 py-1 text-[10px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">Save</button>
              </div>
            </div>
          </div>
        );
      })(), document.body)}
    </div>
  );
}

// Public Markdown-facing name. PreviewCommentHost remains for non-Markdown
// renderers that reuse the same DOM annotation layer.
export const MarkdownCommentHost = PreviewCommentHost;
