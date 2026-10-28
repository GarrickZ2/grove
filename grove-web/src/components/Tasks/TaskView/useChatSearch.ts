import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

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

/** Text currently rendered in a row, excluding explicitly hidden content. */
function visibleTextNodes(container: HTMLElement): Text[] {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || !node.textContent || parent.closest(
        "[data-grove-search-bar], [data-grove-search-skip], [hidden], [aria-hidden='true'], script, style, noscript",
      )) return NodeFilter.FILTER_REJECT;
      for (let el: HTMLElement | null = parent; el && el !== container; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) texts.push(node as Text);
  return texts;
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
 *   useDomSearch only sees what's currently in the DOM. With a virtual list
 *   rendering only the visible window, off-screen messages would be
 *   invisible to the search. Here we scan the full message data to
 *   compute total/navigation, then re-apply visible-DOM highlights
 *   whenever the list renders new items (driven by `renderToken`).
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
  virtuosoRef?: RefObject<{
    scrollToIndex: (options: {
      index: number;
      align: "center";
      behavior: "auto";
    }) => void;
  } | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Bumped by the caller whenever the list renders a different range of
   *  items, so we can re-apply highlights to the freshly mounted DOM. */
  renderToken: number;
  ensureItemAvailable?: (itemIndex: number) => boolean;
  virtuosoIndexForItem?: (itemIndex: number) => number;
  navigationVersion?: number;
  scrollToItem?: (itemIndex: number) => void;
}): ChatSearchResult {
  const {
    items,
    query,
    enabled,
    extractText,
    virtuosoRef,
    scrollerRef,
    renderToken,
    ensureItemAvailable,
    virtuosoIndexForItem,
    navigationVersion,
    scrollToItem,
  } = opts;
  // Belt-and-suspenders: gate on `Highlight` global existing too. WebKit
  // and Chromium ship CSS.highlights and Highlight together in practice,
  // but the older Tauri webview can have one without the other.
  const supportsHighlight =
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined";

  // Mounted rows reflect local accordion state; off-screen rows use the
  // conservative data-layer fallback.
  const [visibleRows, setVisibleRows] = useState<Map<number, string[]>>(() => new Map());
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return;
    let timer: number | undefined;
    const readRows = () => {
      const rows = new Map<number, string[]>();
      scroller.querySelectorAll<HTMLElement>("[data-item-index]").forEach((row) => {
        const index = Number(row.dataset.itemIndex);
        if (Number.isInteger(index)) rows.set(index, visibleTextNodes(row).map((node) => node.data));
      });
      setVisibleRows((previous) => {
        if (previous.size === rows.size && [...rows].every(([key, value]) =>
          JSON.stringify(previous.get(key)) === JSON.stringify(value))) return previous;
        return rows;
      });
    };
    readRows();
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readRows, 200);
    });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-expanded", "aria-hidden", "hidden"] });
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [enabled, scrollerRef, renderToken, items]);

  const matches = useMemo<Match[]>(() => {
    if (!enabled || !query) return [];
    const q = query.toLowerCase();
    const out: Match[] = [];
    items.forEach((it, idx) => {
      const texts = visibleRows.get(idx) ?? [extractText(it)];
      let intra = 0;
      for (const value of texts) {
        const text = value.toLowerCase();
        let i = 0;
        while ((i = text.indexOf(q, i)) !== -1) {
          out.push({ itemIndex: idx, intra });
          intra += 1;
          i += q.length;
        }
      }
    });
    return out;
  }, [items, query, enabled, extractText, visibleRows]);

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

  // Track the match key the auto-scroll effects last centered on.
  // The effects re-run on every messages/renderToken churn while the
  // search bar is open, but we only want to bring the match into view
  // when the user *actually* navigated to it (next/prev). Without this
  // gate, a streaming chunk arriving minutes after the user settled on
  // a match would yank the viewport back to center on the match.
  const lastScrolledKeyRef = useRef<string>("");
  // Reset the gate when the search session changes (new query, toggled
  // off/on) so the first nav of a fresh session can re-center.
  useEffect(() => {
    if (!enabled) {
      lastScrolledKeyRef.current = "";
    } else if (navKey !== focusKey.navKey) {
      lastScrolledKeyRef.current = "";
    }
  }, [enabled, navKey, focusKey.navKey]);

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
    try { CSS.highlights.delete(HL_ALL); } catch { /* noop */ }
    try { CSS.highlights.delete(HL_CUR); } catch { /* noop */ }
  }, [supportsHighlight]);

  // When the user navigates to a different match, ask the list to bring
  // its row into view. Highlight application waits for the next renderToken
  // bump (since Virtuoso may need a frame to mount the row).
  //
  // Gated on `lastScrolledKeyRef`: re-fires from streaming/renderToken
  // churn must NOT re-center — that would fight the user's manual scroll
  // the moment a WS event arrives minutes later.
  useEffect(() => {
    if (matches.length === 0) return;
    const m = matches[cur];
    if (!m) return;
    const key = matchKey(m);
    if (key === lastScrolledKeyRef.current) return;
    if (ensureItemAvailable && !ensureItemAvailable(m.itemIndex)) return;
    lastScrolledKeyRef.current = key;
    const mountedRow = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-item-index="${m.itemIndex}"]`,
    );
    if (mountedRow) {
      mountedRow.scrollIntoView({ block: "center", behavior: "auto" });
      return;
    }
    if (scrollToItem) {
      scrollToItem(m.itemIndex);
      return;
    }
    virtuosoRef?.current?.scrollToIndex({
      index: virtuosoIndexForItem?.(m.itemIndex) ?? m.itemIndex,
      align: "center",
      behavior: "auto",
    });
  }, [
    cur,
    ensureItemAvailable,
    matches,
    navigationVersion,
    scrollerRef,
    scrollToItem,
    virtuosoIndexForItem,
    virtuosoRef,
  ]);

  // Apply highlights to whatever the virtual list currently has rendered.
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

    // Every rendered row exposes its stable transcript index.
    const containers = scroller.querySelectorAll<HTMLElement>(
      "[data-item-index]",
    );
    const allRanges: Range[] = [];
    let currentRange: Range | null = null;

    containers.forEach((container) => {
      const idxAttr = container.getAttribute("data-item-index");
      if (idxAttr === null) return;
      const itemIdx = Number(idxAttr);

      const texts = visibleTextNodes(container);

      let intra = 0;
      for (const tn of texts) {
        const text = tn.textContent ?? "";
        const lower = text.toLowerCase();
        let i = 0;
        while ((i = lower.indexOf(q, i)) !== -1) {
          const r = document.createRange();
          let ok = true;
          try {
            r.setStart(tn, i);
            r.setEnd(tn, i + qLen);
          } catch {
            ok = false;
          }
          if (ok) {
            allRanges.push(r);
            const isTarget =
              target !== undefined &&
              itemIdx === target.itemIndex &&
              intra === target.intra;
            if (isTarget) {
              currentRange = r;
            }
          }
          intra += 1;
          i += qLen;
        }
      }
    });

    const all = new Highlight();
    for (const r of allRanges) all.add(r);
    try { CSS.highlights.set(HL_ALL, all); } catch { /* noop */ }
    if (currentRange) {
      const cr: Range = currentRange;
      const h = new Highlight();
      h.add(cr);
      try { CSS.highlights.set(HL_CUR, h); } catch { /* noop */ }
      // Use "auto" so this scroll doesn't fight Virtuoso's own
      // (instant) scrollToIndex above. With both instant the user sees
      // a single jump rather than a two-stage animation.
      //
      // Gated on lastScrolledKeyRef: this effect re-runs on every
      // renderToken bump (Virtuoso rendering a new range), so without
      // the gate, scrolling away from a match would just yank the
      // viewport back as soon as Virtuoso decided to mount a new
      // range above/below the current position.
      const targetKey = target ? matchKey(target) : "";
      if (targetKey && targetKey !== lastScrolledKeyRef.current) {
        lastScrolledKeyRef.current = targetKey;
        cr.startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "auto",
        });
      }
    }
  }, [
    matches,
    cur,
    query,
    enabled,
    supportsHighlight,
    scrollerRef,
    renderToken,
    visibleRows,
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
