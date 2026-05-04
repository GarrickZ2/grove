import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PreviewCommentMarker, RenderFullProps } from './previewRenderers';
import type { PreviewCommentLocator } from '../../context';

interface ResolvedMarker {
  id: string;
  label: string;
  rect: DOMRect;
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
    const rect = cur.getBoundingClientRect();
    if (BLOCK_TAGS.has(tag)) return cur;
    if (tag === 'div' && rect.width >= 24 && rect.height >= 16) return cur;
    if (/^h[1-6]$/.test(tag) || tag === 'p') return cur;
    cur = cur.parentElement;
  }
  return el;
}

export function PreviewCommentHost({ previewComment, children }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
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

    const onMove = (e: MouseEvent) => {
      const el = pickBlock(e.target as Element, content);
      if (!el) return;
      setHoverRect(el.getBoundingClientRect());
    };
    const onClick = (e: MouseEvent) => {
      const el = pickBlock(e.target as Element, content);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      window.postMessage({
        type: 'grove-preview-comment:selected',
        previewId,
        payload: describe(el, content),
      }, '*');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        window.postMessage({ type: 'grove-preview-comment:cancel', previewId }, '*');
      }
    };

    content.addEventListener('mousemove', onMove, true);
    content.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    content.style.cursor = 'crosshair';

    return () => {
      content.removeEventListener('mousemove', onMove, true);
      content.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      content.style.cursor = '';
      setHoverRect(null);
    };
  }, [enabled, previewId]);

  // Resolve marker bounding rects + reposition on layout changes
  useEffect(() => {
    const content = contentRef.current;
    const host = hostRef.current;
    if (!content || !host) return;
    const markers = JSON.parse(markersKey) as PreviewCommentMarker[];

    const resolve = () => {
      const resolved: ResolvedMarker[] = [];
      for (const m of markers) {
        let el: Element | null = null;
        if (m.selector) {
          try { el = content.querySelector(m.selector); } catch { /* noop */ }
        }
        if (!el && m.xpath) {
          let r: XPathResult | null = null;
          try {
            r = document.evaluate(m.xpath, content, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          } catch { /* noop */ }
          const node = r ? r.singleNodeValue : null;
          if (node && node.nodeType === 1) el = node as Element;
        }
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            resolved.push({ id: m.id, label: m.label, rect });
          }
        }
      }
      setMarkerRects(resolved);
    };

    resolve();

    // Settle verification — a longer window (6s) plus debounce-on-mutation
    // prevents false positives for async-rendered content (Mermaid/D2/SVG).
    let verifyTimer: ReturnType<typeof setTimeout> | null = null;
    const doVerify = () => {
      verifyTimer = null;
      if (!previewId) return;
      const stale: string[] = [];
      for (const m of markers) {
        let el: Element | null = null;
        if (m.selector) { try { el = content.querySelector(m.selector); } catch { /* noop */ } }
        if (!el && m.xpath) {
          let r: XPathResult | null = null;
          try {
            r = document.evaluate(m.xpath, content, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          } catch { /* noop */ }
          const node = r ? r.singleNodeValue : null;
          if (node && node.nodeType === 1) el = node as Element;
        }
        if (!el) stale.push(m.id);
      }
      if (stale.length) {
        window.postMessage({ type: 'grove-preview-comment:markers-stale', previewId, ids: stale }, '*');
      }
    };
    const scheduleVerify = () => {
      if (verifyTimer) clearTimeout(verifyTimer);
      verifyTimer = setTimeout(doVerify, 6000);
    };
    scheduleVerify();

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
      {enabled && hoverRect && hostRect && (
        <div
          data-grove-comment-overlay="true"
          className="pointer-events-none absolute"
          style={{
            left: hoverRect.left - hostRect.left,
            top: hoverRect.top - hostRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
            border: '2px solid var(--color-highlight)',
            background: 'color-mix(in srgb, var(--color-highlight) 12%, transparent)',
            boxShadow: '0 0 0 1px rgba(255,255,255,.85), 0 0 0 4px color-mix(in srgb, var(--color-highlight) 18%, transparent)',
            zIndex: 50,
          }}
        />
      )}
      {hostRect && markerRects.map(({ id, label, rect }) => (
        <div
          key={id}
          data-grove-comment-overlay="true"
          className="pointer-events-none absolute"
          style={{
            left: rect.left - hostRect.left,
            top: rect.top - hostRect.top,
            width: rect.width,
            height: rect.height,
            border: '1.5px dashed color-mix(in srgb, var(--color-highlight) 85%, transparent)',
            background: 'color-mix(in srgb, var(--color-highlight) 8%, transparent)',
            boxShadow: '0 0 0 1px rgba(255,255,255,.7)',
            borderRadius: 3,
            zIndex: 49,
          }}
        >
          <div
            className="absolute flex items-center justify-center text-[11px] font-semibold text-white transition-transform hover:scale-110"
            style={{
              left: -6,
              top: -10,
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
      ))}
    </div>
  );
}
