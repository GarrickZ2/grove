import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { VirtuosoHandle } from "react-virtuoso";

interface Match {
  itemIndex: number;
  /** 0-based occurrence within this item's flattened text */
  intra: number;
}

const HL_ALL = "grove-chat-search";
const HL_CUR = "grove-chat-search-current";
const STYLE_ID = "grove-chat-search-style";

function searchKey(query: string, enabled: boolean): string {
  return enabled ? `q:${query}` : "";
}

/** Stable string key for a match identity. Used to anchor the user's
 *  current focus to a specific (itemIndex, intra) pair so that streaming
 *  inserting earlier matches doesn't make the focused match jump. */
function matchKey(m: Match): string {
  return `${m.itemIndex}:${m.intra}`;
}

export interface ChatSearchResult {
  total: number;
  /** 0-indexed; equals 0 when total === 0 */
  current: number;
  next: () => void;
  prev: () => void;
}

/**
 * Data-layer search for the (virtualized) chat list.
 *
 * Why not reuse useDomSearch?
 *   useDomSearch only sees what's currently in the DOM. With Virtuoso
 *   rendering only the visible window, off-screen messages would be
 *   invisible to the search. Here we scan the full message data to
 *   compute total/navigation, then re-apply visible-DOM highlights
 *   whenever Virtuoso renders new items (driven by `renderToken`).
 *
 * Highlighting uses the CSS Custom Highlight API exclusively — falls back
 * to no highlight on browsers without it (Tauri's WebKit ships it on the
 * versions Grove targets).
 */
export function useChatSearch<T>(opts: {
  items: T[];
  query: string;
  enabled: boolean;
  extractText: (item: T) => string;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Bumped by the caller whenever Virtuoso renders a different range of
   *  items, so we can re-apply highlights to the freshly mounted DOM. */
  renderToken: number;
}): ChatSearchResult {
  const {
    items,
    query,
    enabled,
    extractText,
    virtuosoRef,
    scrollerRef,
    renderToken,
  } = opts;
  // Belt-and-suspenders: gate on `Highlight` global existing too. WebKit
  // and Chromium ship CSS.highlights and Highlight together in practice,
  // but the older Tauri webview can have one without the other.
  const supportsHighlight =
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined";

  const matches = useMemo<Match[]>(() => {
    if (!enabled || !query) return [];
    const q = query.toLowerCase();
    const out: Match[] = [];
    items.forEach((it, idx) => {
      const text = extractText(it).toLowerCase();
      if (!text) return;
      let i = 0;
      let intra = 0;
      while ((i = text.indexOf(q, i)) !== -1) {
        out.push({ itemIndex: idx, intra });
        intra += 1;
        i += q.length;
      }
    });
    return out;
  }, [items, query, enabled, extractText]);

  // Anchor focus to the (itemIndex, intra) pair, NOT an ordinal index.
  // During streaming, new matches may appear earlier in the list (e.g.
  // a tool message gets a new chunk that contains the query) — that
  // would otherwise shift every later match's ordinal and make the
  // user's focus jump. Anchoring on the identity keeps focus stable.
  const [focusKey, setFocusKey] = useState<{ navKey: string; key: string }>(
    () => ({
      navKey: searchKey(query, enabled),
      key: "",
    }),
  );
  const navKey = searchKey(query, enabled);

  // If the search query/enabled changed, the focus key is stale; treat
  // current as 0 and let next nav re-anchor.
  const focusKeyForNav = focusKey.navKey === navKey ? focusKey.key : "";

  // Resolve focus key → ordinal index in the current matches list.
  const cur = useMemo(() => {
    if (matches.length === 0) return 0;
    if (!focusKeyForNav) return 0;
    const i = matches.findIndex((m) => matchKey(m) === focusKeyForNav);
    return i >= 0 ? i : 0;
  }, [matches, focusKeyForNav]);

  // Stable refs so next/prev callbacks keep their identity across
  // streaming token bumps. Updated in an effect (refs must not be
  // mutated during render).
  const matchesRef = useRef<Match[]>(matches);
  const curRef = useRef(cur);
  useEffect(() => {
    matchesRef.current = matches;
    curRef.current = cur;
  }, [matches, cur]);

  // Inject highlight styles once.
  useEffect(() => {
    if (!supportsHighlight) return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent =
      "::highlight(grove-chat-search){background-color:color-mix(in srgb, var(--color-warning) 55%, transparent);color:inherit;}" +
      "::highlight(grove-chat-search-current){background-color:color-mix(in srgb, var(--color-warning) 90%, transparent);color:#1a1a1a;}";
    document.head.appendChild(el);
  }, [supportsHighlight]);

  const clearHighlights = useCallback(() => {
    if (!supportsHighlight) return;
    try {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
    } catch {
      /* noop */
    }
  }, [supportsHighlight]);

  // When the user navigates to a different match, ask Virtuoso to bring
  // its row into view. Highlight application waits for the next renderToken
  // bump (since Virtuoso may need a frame to mount the row).
  useEffect(() => {
    if (matches.length === 0) return;
    const m = matches[cur];
    if (!m) return;
    virtuosoRef.current?.scrollToIndex({
      index: m.itemIndex,
      align: "center",
      behavior: "auto",
    });
  }, [cur, matches, virtuosoRef]);

  // Apply highlights to whatever Virtuoso currently has rendered.
  // Re-runs when the rendered range changes (renderToken), the query
  // changes, or the user navigates.
  useEffect(() => {
    if (!supportsHighlight) {
      clearHighlights();
      return;
    }
    clearHighlights();
    if (!enabled || !query || matches.length === 0 || !scrollerRef.current) {
      return;
    }
    const scroller = scrollerRef.current;
    const q = query.toLowerCase();
    const qLen = query.length;
    const target = matches[cur];

    // Virtuoso adds data-item-index on each rendered row.
    const containers = scroller.querySelectorAll<HTMLElement>(
      "[data-item-index]",
    );
    const allRanges: Range[] = [];
    let currentRange: Range | null = null;

    containers.forEach((container) => {
      const idxAttr = container.getAttribute("data-item-index");
      if (idxAttr === null) return;
      const itemIdx = Number(idxAttr);

      const texts: Text[] = [];
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest("[data-grove-search-bar]"))
              return NodeFilter.FILTER_REJECT;
            if (parent.closest("[data-grove-search-skip]"))
              return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName?.toLowerCase();
            if (tag === "script" || tag === "style" || tag === "noscript")
              return NodeFilter.FILTER_REJECT;
            if (!node.textContent) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      let n: Node | null;
      while ((n = walker.nextNode())) texts.push(n as Text);

      let intra = 0;
      for (const tn of texts) {
        const text = tn.textContent ?? "";
        const lower = text.toLowerCase();
        let i = 0;
        while ((i = lower.indexOf(q, i)) !== -1) {
          const r = document.createRange();
          try {
            r.setStart(tn, i);
            r.setEnd(tn, i + qLen);
            allRanges.push(r);
            if (
              target &&
              itemIdx === target.itemIndex &&
              intra === target.intra
            ) {
              currentRange = r;
            }
          } catch {
            /* noop */
          }
          intra += 1;
          i += qLen;
        }
      }
    });

    try {
      const all = new Highlight();
      for (const r of allRanges) all.add(r);
      CSS.highlights.set(HL_ALL, all);
      if (currentRange) {
        const cr: Range = currentRange;
        const h = new Highlight();
        h.add(cr);
        CSS.highlights.set(HL_CUR, h);
        // Use "auto" so this scroll doesn't fight Virtuoso's own
        // (instant) scrollToIndex above. With both instant the user sees
        // a single jump rather than a two-stage animation.
        cr.startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "auto",
        });
      }
    } catch {
      /* noop */
    }
  }, [
    matches,
    cur,
    query,
    enabled,
    supportsHighlight,
    scrollerRef,
    renderToken,
    clearHighlights,
  ]);

  // (Disabling search clears highlights via the main effect above, which
  // calls clearHighlights() at its top whenever `enabled` flips. No
  // dedicated unmount cleanup needed — taking down the chat tears the
  // document down anyway.)

  // next/prev step the focus key. They read matches/cur via refs so their
  // identity stays stable across re-renders (only navKey changes flip them).
  // When the focus key is stale (no anchor yet, or matches changed under
  // us so cur was forced back to 0), the FIRST navigation should land on
  // ms[0] / ms[len-1] rather than stepping off cur=0.
  const focusKeyForNavRef = useRef(focusKeyForNav);
  useEffect(() => {
    focusKeyForNavRef.current = focusKeyForNav;
  }, [focusKeyForNav]);
  const next = useCallback(() => {
    const ms = matchesRef.current;
    if (ms.length === 0) return;
    const stale = !focusKeyForNavRef.current;
    const nextIdx = stale ? 0 : (curRef.current + 1) % ms.length;
    setFocusKey({ navKey, key: matchKey(ms[nextIdx]) });
  }, [navKey]);
  const prev = useCallback(() => {
    const ms = matchesRef.current;
    if (ms.length === 0) return;
    const stale = !focusKeyForNavRef.current;
    const prevIdx = stale
      ? ms.length - 1
      : (curRef.current - 1 + ms.length) % ms.length;
    setFocusKey({ navKey, key: matchKey(ms[prevIdx]) });
  }, [navKey]);

  return {
    total: matches.length,
    current: matches.length === 0 ? 0 : cur,
    next,
    prev,
  };
}
