import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface UseDomSearchResult {
  total: number;
  current: number; // 0-indexed; 0 when total === 0
  next: () => void;
  prev: () => void;
}

function trySetRange(r: Range, node: Text, start: number, end: number): boolean {
  try {
    r.setStart(node, start);
    r.setEnd(node, end);
    return true;
  } catch {
    return false;
  }
}

const SEARCH_HIGHLIGHT = "grove-search";
const SEARCH_HIGHLIGHT_CURRENT = "grove-search-current";
const MARK_ATTR = "data-grove-search-mark";
const MARK_CURRENT_ATTR = "data-grove-search-mark-current";

/**
 * Search text inside the given root using:
 *   1. CSS Custom Highlight API when available — no DOM mutation, zero churn
 *   2. <mark> injection as fallback for older browsers
 *
 * Skips text inside our own UI (search bar, comment overlays).
 *
 * `enabled` toggles whether the hook is active; when false, all highlights
 * are removed immediately so closing the search bar fully clears the page.
 */
export function useDomSearch(
  rootRef: RefObject<HTMLElement | null>,
  query: string,
  enabled: boolean,
): UseDomSearchResult {
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const marksRef = useRef<HTMLElement[]>([]);
  const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS;

  useEffect(() => {
    if (!supportsHighlight || document.getElementById("grove-search-highlight-style")) return;
    const style = document.createElement("style");
    style.id = "grove-search-highlight-style";
    style.textContent =
      "::highlight(grove-search){background-color:color-mix(in srgb, var(--color-warning) 55%, transparent);color:inherit;}" +
      "::highlight(grove-search-current){background-color:color-mix(in srgb, var(--color-warning) 90%, transparent);color:#1a1a1a;}";
    document.head.appendChild(style);
  }, [supportsHighlight]);

  const clearHighlights = useCallback(() => {
    if (supportsHighlight) {
      try { CSS.highlights.delete(SEARCH_HIGHLIGHT); } catch { /* noop */ }
      try { CSS.highlights.delete(SEARCH_HIGHLIGHT_CURRENT); } catch { /* noop */ }
    }
    if (marksRef.current.length) {
      for (const m of marksRef.current) {
        const parent = m.parentNode;
        if (!parent) continue;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      }
      marksRef.current = [];
    }
    rangesRef.current = [];
  }, [supportsHighlight]);

  // Re-compute on query / enabled / root change
  useEffect(() => {
    let cancelled = false;
    const commitState = (nextTotal: number, nextCurrent: number) => {
      queueMicrotask(() => {
        if (cancelled) return;
        setTotal(nextTotal);
        setCurrent(nextCurrent);
      });
    };

    clearHighlights();
    if (!enabled || !query || !rootRef.current) {
      commitState(0, 0);
      return () => {
        cancelled = true;
      };
    }

    const root = rootRef.current;
    const lowerQuery = query.toLowerCase();
    const queryLen = query.length;

    // Phase 1: collect text nodes (skip our UI subtrees)
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-grove-search-bar]")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-grove-comment-overlay]")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-grove-preview-comment-overlay]")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-grove-search-skip]")) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName?.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

    if (supportsHighlight) {
      // Phase 2a: build Range list
      const ranges: Range[] = [];
      for (const tn of textNodes) {
        const text = tn.textContent ?? "";
        const lower = text.toLowerCase();
        let i = 0;
        while ((i = lower.indexOf(lowerQuery, i)) !== -1) {
          const r = document.createRange();
          const ok = trySetRange(r, tn, i, i + queryLen);
          if (ok) ranges.push(r);
          i += queryLen;
        }
      }
      rangesRef.current = ranges;
      commitState(ranges.length, 0);
      if (ranges.length) {
        const hlAll = new Highlight();
        for (const r of ranges) hlAll.add(r);
        const hlCur = new Highlight();
        hlCur.add(ranges[0]);
        try { CSS.highlights.set(SEARCH_HIGHLIGHT, hlAll); } catch { /* noop */ }
        try { CSS.highlights.set(SEARCH_HIGHLIGHT_CURRENT, hlCur); } catch { /* noop */ }
      }
    } else {
      // Phase 2b: <mark> injection fallback
      const marks: HTMLElement[] = [];
      for (const tn of textNodes) {
        const text = tn.textContent ?? "";
        const lower = text.toLowerCase();
        const occurrences: number[] = [];
        let i = 0;
        while ((i = lower.indexOf(lowerQuery, i)) !== -1) {
          occurrences.push(i);
          i += queryLen;
        }
        if (!occurrences.length) continue;
        // Walk occurrences right-to-left so earlier indices stay valid as we split.
        const parent = tn.parentNode;
        if (!parent) continue;
        let cursor = tn;
        let consumed = 0;
        for (const occ of occurrences) {
          const localStart = occ - consumed;
          const after = cursor.splitText(localStart);
          const matched = after.splitText(queryLen);
          const mark = document.createElement("mark");
          mark.setAttribute(MARK_ATTR, "true");
          mark.appendChild(after);
          parent.insertBefore(mark, matched);
          marks.push(mark);
          cursor = matched;
          consumed = occ + queryLen;
        }
      }
      marksRef.current = marks;
      commitState(marks.length, 0);
      if (marks.length) {
        marks[0].setAttribute(MARK_CURRENT_ATTR, "true");
      }
    }

    return () => {
      cancelled = true;
      clearHighlights();
    };
  }, [query, enabled, rootRef, supportsHighlight, clearHighlights]);

  // When `current` changes, update which match is the "current" one + scroll into view.
  useEffect(() => {
    if (total === 0) return;
    const idx = ((current % total) + total) % total;
    if (supportsHighlight) {
      const range = rangesRef.current[idx];
      if (!range) return;
      const h = new Highlight();
      h.add(range);
      try { CSS.highlights.set(SEARCH_HIGHLIGHT_CURRENT, h); } catch { /* noop */ }
      // Scroll the start container into view
      const target = range.startContainer.parentElement;
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      for (const m of marksRef.current) m.removeAttribute(MARK_CURRENT_ATTR);
      const m = marksRef.current[idx];
      if (!m) return;
      m.setAttribute(MARK_CURRENT_ATTR, "true");
      m.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [current, total, supportsHighlight]);

  const next = useCallback(() => {
    setCurrent((c) => (total === 0 ? 0 : (c + 1) % total));
  }, [total]);
  const prev = useCallback(() => {
    setCurrent((c) => (total === 0 ? 0 : (c - 1 + total) % total));
  }, [total]);

  return { total, current, next, prev };
}
