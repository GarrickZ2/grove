import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PreviewCommentMarker, RenderFullProps } from './previewRenderers';
import type { PreviewCommentLocator } from '../../context';

interface ResolvedMarker {
  id: string;
  label: string;
  rects: DOMRect[];
}

interface Props {
  previewComment?: RenderFullProps['previewComment'];
  children: ReactNode;
}

const BLOCK_TAGS = new Set([
  'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
  'form', 'table', 'tr', 'li', 'button', 'a', 'img', 'svg', 'canvas',
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

export function PreviewCommentHost({ previewComment, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hoverRects, setHoverRects] = useState<DOMRect[]>([]);
  const [markerRects, setMarkerRects] = useState<ResolvedMarker[]>([]);
  const [hostRect, setHostRect] = useState<DOMRect | null>(null);

  const enabled = !!previewComment?.enabled;
  const previewId = previewComment?.previewId;

  const markersKey = useMemo(
    () => JSON.stringify(previewComment?.markers ?? []),
    [previewComment?.markers],
  );

  // Keep hostRect fresh (for absolute overlay positioning relative to host)
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostRect(host.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, []);

  // Comment mode listeners
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !enabled || !previewId) return;

    let startBlock: Element | null = null;
    let lastBlocks: Element[] = [];

    const resetDrag = () => {
      startBlock = null;
      lastBlocks = [];
    };

    const onMouseDown = (e: MouseEvent) => {
      const el = pickBlock(e.target as Element, content);
      if (!el) return;
      startBlock = el;
      lastBlocks = [el];
      setHoverRects([el.getBoundingClientRect()]);
    };

    const onMouseMove = (e: MouseEvent) => {
      // Defensive: if button is released and we still think we're dragging
      // (mouseup was missed because it fired outside this listener), reset.
      if (startBlock && e.buttons === 0) resetDrag();
      const el = pickBlock(e.target as Element, content);
      if (!el) {
        if (!startBlock) setHoverRects([]);
        return;
      }
      if (startBlock) {
        const blocks = blocksBetween(startBlock, el, content);
        lastBlocks = blocks;
        setHoverRects(blocks.map((b) => b.getBoundingClientRect()));
      } else {
        lastBlocks = [el];
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
      let blocks = lastBlocks;
      if (blocks.length === 0) {
        const el = pickBlock(e.target as Element, content);
        if (!el) { resetDrag(); return; }
        blocks = [el];
      }
      resetDrag();
      e.preventDefault();
      e.stopPropagation();
      const payload = blocks.length === 1
        ? describe(blocks[0], content)
        : describeBlocks(blocks, content);
      window.postMessage({
        type: 'grove-preview-comment:selected',
        previewId,
        payload,
      }, '*');
    };

    const onMouseLeave = (e: MouseEvent) => {
      // If button isn't held, force-reset; matches behavior when mouseup
      // fires outside the listener target.
      if (e.buttons === 0) {
        resetDrag();
        setHoverRects([]);
      } else if (!startBlock) {
        setHoverRects([]);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        resetDrag();
        setHoverRects([]);
        window.postMessage({ type: 'grove-preview-comment:cancel', previewId }, '*');
      }
    };

    content.addEventListener('mousedown', onMouseDown, true);
    content.addEventListener('mousemove', onMouseMove, true);
    content.addEventListener('mouseup', onMouseUp, true);
    content.addEventListener('mouseleave', onMouseLeave, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('keydown', onKey, true);
    content.style.cursor = 'crosshair';

    return () => {
      content.removeEventListener('mousedown', onMouseDown, true);
      content.removeEventListener('mousemove', onMouseMove, true);
      content.removeEventListener('mouseup', onMouseUp, true);
      content.removeEventListener('mouseleave', onMouseLeave, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('keydown', onKey, true);
      content.style.cursor = '';
      setHoverRects([]);
    };
  }, [enabled, previewId]);

  // Resolve marker bounding rects + reposition on layout changes
  useEffect(() => {
    const content = contentRef.current;
    const host = hostRef.current;
    if (!content || !host) return;
    const markers = JSON.parse(markersKey) as PreviewCommentMarker[];

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

    const resolveAll = (m: PreviewCommentMarker): Element[] => {
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
      const resolved: ResolvedMarker[] = [];
      for (const m of markers) {
        const els = resolveAll(m);
        if (els.length === 0) continue;
        const rects = els
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0);
        if (rects.length > 0) {
          resolved.push({ id: m.id, label: m.label, rects });
        }
      }
      setMarkerRects(resolved);
    };

    resolve();

    // Settle verification — a longer window (6s) plus debounce-on-mutation
    // prevents false positives for async-rendered content (Mermaid/D2/SVG).
    let verifyTimer: ReturnType<typeof setTimeout> | null = null;
    let verifyDeadline = 0;
    const doVerify = () => {
      verifyTimer = null;
      verifyDeadline = 0;
      if (!previewId) return;
      const stale: string[] = [];
      for (const m of markers) {
        // A marker is stale only if its primary block can't be resolved.
        // Missing extra blocks degrade gracefully (fewer rects).
        if (!lookupOne(m.selector, m.xpath)) stale.push(m.id);
      }
      if (stale.length) {
        window.postMessage({ type: 'grove-preview-comment:markers-stale', previewId, ids: stale }, '*');
      }
    };
    // Standard debounce 6s, but cap with a 30s hard deadline so a constantly
    // mutating preview (animations, async data) still gets verified instead
    // of resetting the timer indefinitely.
    const scheduleVerify = () => {
      const now = Date.now();
      if (!verifyDeadline) verifyDeadline = now + 30000;
      const remaining = Math.max(0, verifyDeadline - now);
      const delay = Math.min(6000, remaining);
      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = setTimeout(doVerify, delay);
    };
    if (markers.length) scheduleVerify();

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        resolve();
        if (markers.length) scheduleVerify();
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
      if (verifyTimer) clearTimeout(verifyTimer);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [markersKey, previewId]);

  return (
    <div ref={hostRef} className="relative w-full h-full">
      <div ref={contentRef} className="w-full h-full">
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
      {hostRect && markerRects.map(({ id, label, rects }) => {
        const u = unionRect(rects)!;
        return (
        <div key={id} data-grove-comment-overlay="true" className="pointer-events-none absolute" style={{ inset: 0, zIndex: 49 }}>
          <div
            className="absolute"
            style={{
              left: u.left - hostRect.left,
              top: u.top - hostRect.top,
              width: u.width,
              height: u.height,
              border: '1.5px dashed color-mix(in srgb, var(--color-highlight) 85%, transparent)',
              background: 'color-mix(in srgb, var(--color-highlight) 8%, transparent)',
              boxShadow: '0 0 0 1px rgba(255,255,255,.7)',
              borderRadius: 3,
            }}
          />
          <div
            className="absolute flex items-center justify-center text-[11px] font-semibold text-white transition-transform hover:scale-110"
            style={{
              left: u.left - hostRect.left - 6,
              top: u.top - hostRect.top - 10,
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
              window.postMessage({ type: 'grove-preview-comment:marker-click', previewId, markerId: id }, '*');
            }}
          >
            {label}
          </div>
        </div>
        );
      })}
    </div>
  );
}
