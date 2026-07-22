import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { createSlugger } from "./headingSlug";
import type { TocEntry } from "./MarkdownToc";

/**
 * Block-level virtualized markdown renderer for huge documents (≥30k chars).
 *
 * Splits the source into top-level mdast blocks and renders only the on-screen
 * blocks via Virtuoso. Each block goes through the existing MarkdownRenderer,
 * so code blocks, mermaid, file chips etc. all continue to work without any
 * special handling here.
 *
 * Cmd+F search runs against a pre-computed plaintext index — not the DOM —
 * so it never has to walk a 15k-line tree. Navigating to a match scrolls
 * Virtuoso to the owning block, waits for it to mount, then highlights the
 * matched range using the standard CSS Custom Highlight API.
 */

interface MdastBlock {
  /** Raw source slice for this block; fed back into MarkdownRenderer. */
  source: string;
  /** Concatenated text content (skipping ambient decorations) — search index. */
  plaintext: string;
  /** Cached lowercase plaintext for case-insensitive search. */
  plaintextLower: string;
}

export interface VirtualizedMarkdownHeading extends TocEntry {
  /** Index into the block array, for scrollToIndex. */
  blockIndex: number;
}

export interface VirtualizedMarkdownHandle {
  scrollToBlockIndex: (index: number) => void;
  scrollToHeadingId: (id: string) => void;
  setSearchQuery: (q: string) => void;
  searchNext: () => void;
  searchPrev: () => void;
}

export interface VirtualizedMarkdownRendererProps {
  content: string;
  /** Forwarded as `style` on the outer Virtuoso container. */
  style?: CSSProperties;
  className?: string;
  /** Reported back so the parent's search bar can show counts / drive nav. */
  onSearchStateChange?: (total: number, current: number) => void;
  /** Reported back so the parent can render its TocPanel. */
  onHeadingsChange?: (headings: VirtualizedMarkdownHeading[]) => void;
  /** Reported back so TocPanel's "active heading" logic can hook into a
   *  scroll surface that exists (Virtuoso's internal scroller, not the
   *  drawer body). */
  onScrollerRef?: (el: HTMLElement | null) => void;
  // Pass-through props to MarkdownRenderer:
  onFileClick?: React.ComponentProps<typeof MarkdownRenderer>["onFileClick"];
  resolveImageUrl?: React.ComponentProps<typeof MarkdownRenderer>["resolveImageUrl"];
  onMermaidClick?: React.ComponentProps<typeof MarkdownRenderer>["onMermaidClick"];
  onD2Click?: React.ComponentProps<typeof MarkdownRenderer>["onD2Click"];
  onImageClick?: React.ComponentProps<typeof MarkdownRenderer>["onImageClick"];
  enableRunCommand?: boolean;
  sketchContext?: React.ComponentProps<typeof MarkdownRenderer>["sketchContext"];
  sketchRenderMode?: React.ComponentProps<typeof MarkdownRenderer>["sketchRenderMode"];
  /** Storage namespace and path of the markdown file. */
  location?: React.ComponentProps<typeof MarkdownRenderer>["location"];
}

/** Recursively pull text out of an mdast node. Must match exactly what the
 *  DOM TreeWalker would observe via `textContent` so search offsets land on
 *  the right characters — i.e. NO whitespace separators between children.
 *  `Element.textContent` is a straight concatenation of descendant text
 *  nodes; adding "\n" between block-level mdast children would push every
 *  subsequent offset forward by phantom characters and misalign highlights. */
function mdastNodeToPlaintext(node: RootContent | Root): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as RootContent[]).map(mdastNodeToPlaintext).join("");
  }
  return "";
}

// Instance-scoped highlight names. CSS Custom Highlight API's `CSS.highlights`
// is a global registry, so a shared name means one VirtualizedMarkdownRenderer
// instance unmounting wipes the highlights of any other instance still
// mounted (e.g. split view with two markdown previews). We mint a unique
// suffix per instance and pair it with a per-instance <style> element that
// declares the matching `::highlight(<name>)` selectors literally (the
// selector can't take a variable).
function makeHighlightNames(instanceId: string): { base: string; current: string } {
  return {
    base: `grove-search-${instanceId}`,
    current: `grove-search-current-${instanceId}`,
  };
}

function installSearchStyle(instanceId: string, names: { base: string; current: string }): () => void {
  if (typeof document === "undefined") return () => {};
  // Idempotent install with refcount: React 19 StrictMode double-mounts
  // components in dev with the SAME useId() value, and Vite HMR can swap a
  // module mid-mount without firing cleanup. Multiple installers may share
  // the same `<style>` node; only the LAST cleanup actually removes it, so
  // a still-mounted sibling instance doesn't lose its highlight styling
  // when another instance unmounts first.
  const existing = document.querySelector<HTMLStyleElement>(
    `style[data-grove-search-instance="${instanceId}"]`,
  );
  if (existing) {
    const prev = Number(existing.dataset.groveSearchRefs ?? "1");
    existing.dataset.groveSearchRefs = String(prev + 1);
    return () => {
      const cur = Number(existing.dataset.groveSearchRefs ?? "1");
      if (cur <= 1) {
        existing.remove();
      } else {
        existing.dataset.groveSearchRefs = String(cur - 1);
      }
    };
  }
  const style = document.createElement("style");
  style.dataset.groveSearchInstance = instanceId;
  style.dataset.groveSearchRefs = "1";
  style.textContent =
    `::highlight(${names.base}){background-color:color-mix(in srgb, var(--color-warning) 55%, transparent);color:inherit;}` +
    `::highlight(${names.current}){background-color:color-mix(in srgb, var(--color-warning) 90%, transparent);color:#1a1a1a;}`;
  document.head.appendChild(style);
  return () => {
    const cur = Number(style.dataset.groveSearchRefs ?? "1");
    if (cur <= 1) {
      style.remove();
    } else {
      style.dataset.groveSearchRefs = String(cur - 1);
    }
  };
}

interface Match {
  blockIndex: number;
  /** Offset within the block's plaintext where the match starts. */
  offsetInBlock: number;
  length: number;
}

interface ParseResult {
  blocks: MdastBlock[];
  headings: VirtualizedMarkdownHeading[];
}

function parseContent(content: string): ParseResult {
  let tree: Root;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
  } catch {
    // Malformed markdown — degrade to a single block so we still render
    // *something* rather than crashing the preview pane.
    return {
      blocks: [
        {
          source: content,
          plaintext: content,
          plaintextLower: content.toLowerCase(),
        },
      ],
      headings: [],
    };
  }
  const blocks: MdastBlock[] = [];
  const headings: VirtualizedMarkdownHeading[] = [];
  const slug = createSlugger();
  for (const node of tree.children) {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? content.length;
    const source = content.slice(start, end);
    const plaintext = mdastNodeToPlaintext(node);
    const blockIndex = blocks.length;
    blocks.push({
      source,
      plaintext,
      plaintextLower: plaintext.toLowerCase(),
    });
    if (node.type === "heading") {
      const text = mdastNodeToPlaintext(node).trim();
      if (text) {
        headings.push({
          id: slug(text),
          text,
          level: node.depth,
          blockIndex,
        });
      }
    }
  }
  return { blocks, headings };
}

/** Walk a block's mounted DOM and locate the (textNode, localOffset) pair
 *  that corresponds to `offsetInBlock` in the precomputed plaintext.
 *
 *  Skips subtrees marked `data-grove-search-skip` so code-block line numbers
 *  and language labels don't shift the offset count. */
function findRangeInBlock(
  blockEl: HTMLElement,
  offsetInBlock: number,
  length: number,
): Range | null {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-grove-search-skip]")) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName?.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let consumed = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const tn = n as Text;
    const text = tn.textContent ?? "";
    // Block separators (newlines) in plaintext are virtual — they're not
    // present in DOM text nodes. So we walk the actual DOM text contiguously
    // and treat the offset as 1:1 with DOM characters.
    if (consumed + text.length >= offsetInBlock) {
      const startInNode = offsetInBlock - consumed;
      const r = document.createRange();
      try {
        r.setStart(tn, startInNode);
        const endInNode = Math.min(startInNode + length, text.length);
        let remaining = length - (endInNode - startInNode);
        // If the match spills past this text node, walk forward across
        // subsequent accepted text nodes and extend the range so we don't
        // under-highlight multi-node hits (common with inline emphasis,
        // links, etc.).
        if (remaining > 0) {
          let endNode: Text = tn;
          let endOffset = endInNode;
          let m: Node | null;
          while (remaining > 0 && (m = walker.nextNode())) {
            const nt = m as Text;
            const nText = nt.textContent ?? "";
            if (nText.length >= remaining) {
              endNode = nt;
              endOffset = remaining;
              remaining = 0;
            } else {
              endNode = nt;
              endOffset = nText.length;
              remaining -= nText.length;
            }
          }
          r.setEnd(endNode, endOffset);
        } else {
          r.setEnd(tn, endInNode);
        }
        return r;
      } catch {
        return null;
      }
    }
    consumed += text.length;
  }
  return null;
}

export const VirtualizedMarkdownRenderer = forwardRef<
  VirtualizedMarkdownHandle,
  VirtualizedMarkdownRendererProps
>(function VirtualizedMarkdownRenderer(props, ref) {
  const {
    content,
    style,
    className,
    onSearchStateChange,
    onHeadingsChange,
    onScrollerRef,
    onFileClick,
    resolveImageUrl,
    onMermaidClick,
    onD2Click,
    onImageClick,
    enableRunCommand,
    sketchContext,
    sketchRenderMode,
    location,
  } = props;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const { blocks, headings } = useMemo(() => parseContent(content), [content]);
  // The set of block indexes currently mounted by Virtuoso. We need it to
  // know when a scrolled-to block is actually in the DOM so we can highlight
  // the match inside it — chasing it via setTimeout would race with item
  // rendering.
  const mountedRangeRef = useRef<{ startIndex: number; endIndex: number }>({
    startIndex: 0,
    endIndex: 0,
  });

  // Per-instance highlight names + matching <style>. Both lifetimes are bound
  // to this component instance so two previews never clobber each other.
  const instanceId = useId().replace(/:/g, "");
  const highlightNames = useMemo(() => makeHighlightNames(instanceId), [instanceId]);
  useEffect(() => {
    const removeStyle = installSearchStyle(instanceId, highlightNames);
    // Snapshot to plain locals so the lint rule that flags `.current`-suffixed
    // closures (assuming React refs) doesn't false-positive on our field name.
    const { base: baseName, current: currentName } = highlightNames;
    return () => {
      removeStyle();
      if (typeof CSS !== "undefined" && "highlights" in CSS) {
        try { CSS.highlights.delete(baseName); } catch { /* noop */ }
        try { CSS.highlights.delete(currentName); } catch { /* noop */ }
      }
    };
  }, [instanceId, highlightNames]);

  useEffect(() => {
    onHeadingsChange?.(headings);
  }, [headings, onHeadingsChange]);

  // ── Search ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [currentMatch, setCurrentMatch] = useState(0);

  // Debounced + chunked match computation, same approach as useDomSearch.
  useEffect(() => {
    if (!query) {
      setMatches([]);
      setCurrentMatch(0);
      return;
    }
    let cancelled = false;
    let rafHandle = 0;
    const debounce = window.setTimeout(() => {
      if (cancelled) return;
      const q = query.toLowerCase();
      const qLen = q.length;
      const out: Match[] = [];
      // Chunk across animation frames so a common query like "the" with
      // tens of thousands of hits doesn't block paint while we count.
      const CHUNK = 200;
      let cursor = 0;
      let chunksSinceFlush = 0;
      let lastFlushAt = 0;
      const tick = () => {
        if (cancelled) return;
        const end = Math.min(cursor + CHUNK, blocks.length);
        for (; cursor < end; cursor++) {
          const text = blocks[cursor].plaintextLower;
          let i = 0;
          while ((i = text.indexOf(q, i)) !== -1) {
            out.push({ blockIndex: cursor, offsetInBlock: i, length: qLen });
            i += qLen;
          }
        }
        chunksSinceFlush += 1;
        const done = cursor >= blocks.length;
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        // Throttle intermediate setMatches calls — large docs with common
        // queries trigger thousands of partial flushes that re-fire the
        // highlight effect for no visible benefit. Last flush always lands.
        if (done || (chunksSinceFlush >= 8 && now - lastFlushAt >= 100)) {
          setMatches(out.slice());
          chunksSinceFlush = 0;
          lastFlushAt = now;
        }
        if (!done) {
          rafHandle = requestAnimationFrame(tick);
        }
      };
      rafHandle = requestAnimationFrame(tick);
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
  }, [query, blocks]);

  // Clamp current match when match list shrinks (query change mid-scan).
  useEffect(() => {
    if (matches.length === 0) {
      setCurrentMatch(0);
      return;
    }
    setCurrentMatch((c) => Math.min(c, matches.length - 1));
  }, [matches.length]);

  useEffect(() => {
    onSearchStateChange?.(matches.length, matches.length === 0 ? 0 : currentMatch);
  }, [matches.length, currentMatch, onSearchStateChange]);

  // Bucket matches by blockIndex so applyVisibleHighlights doesn't have to
  // re-scan all N matches on every scroll tick — it walks only the buckets
  // for the currently-mounted block range.
  const matchesByBlock = useMemo(() => {
    const m = new Map<number, Match[]>();
    for (const match of matches) {
      let bucket = m.get(match.blockIndex);
      if (!bucket) {
        bucket = [];
        m.set(match.blockIndex, bucket);
      }
      bucket.push(match);
    }
    return m;
  }, [matches]);

  // Re-draw ambient highlights for every match in the currently-mounted block
  // range. Without this the user only sees the current match — disorienting
  // when the index says "5/942".
  const applyVisibleHighlights = useCallback(() => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    try { CSS.highlights.delete(highlightNames.base); } catch { /* noop */ }
    if (matches.length === 0) return;
    const { startIndex, endIndex } = mountedRangeRef.current;
    const hl = new Highlight();
    for (let bi = startIndex; bi <= endIndex; bi++) {
      const bucket = matchesByBlock.get(bi);
      if (!bucket) continue;
      const blockEl = document.querySelector<HTMLElement>(
        `[data-virt-block="${bi}"]`,
      );
      if (!blockEl) continue;
      for (const match of bucket) {
        const range = findRangeInBlock(blockEl, match.offsetInBlock, match.length);
        if (range) hl.add(range);
      }
    }
    try { CSS.highlights.set(highlightNames.base, hl); } catch { /* noop */ }
  }, [matches, matchesByBlock, highlightNames]);

  // Shared highlight painter for the "current" match. `scroll` controls
  // whether we also scrollIntoView — must be FALSE on rangeChanged callbacks,
  // otherwise scrolling the user's view triggers a rangeChanged, which would
  // scrollIntoView again, fighting the user's own scroll input.
  const paintCurrentHighlight = useCallback((scroll: boolean) => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    try { CSS.highlights.delete(highlightNames.current); } catch { /* noop */ }
    if (matches.length === 0) return;
    const match = matches[currentMatch];
    if (!match) return;
    const { startIndex, endIndex } = mountedRangeRef.current;
    if (match.blockIndex < startIndex || match.blockIndex > endIndex) return;
    const blockEl = document.querySelector<HTMLElement>(
      `[data-virt-block="${match.blockIndex}"]`,
    );
    if (!blockEl) return;
    const range = findRangeInBlock(blockEl, match.offsetInBlock, match.length);
    if (!range) return;
    const hl = new Highlight();
    hl.add(range);
    try { CSS.highlights.set(highlightNames.current, hl); } catch { /* noop */ }
    if (scroll) {
      // Center the match in the scroller — scrollToIndex already lands the
      // block in view, but its top edge may be hidden under a fixed header.
      range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [matches, currentMatch, highlightNames]);

  const applyCurrentHighlightAndScroll = useCallback(() => {
    paintCurrentHighlight(true);
  }, [paintCurrentHighlight]);
  const applyCurrentHighlightOnly = useCallback(() => {
    paintCurrentHighlight(false);
  }, [paintCurrentHighlight]);

  // Repaint highlights whenever the match set or current index changes.
  // Both apply* helpers handle the empty case by deleting the corresponding
  // Highlight and returning — so we MUST call them unconditionally, before
  // any early-return, or stale ranges from a previous query stick around
  // (e.g. cleared search box still showing yellow highlights).
  //
  // N10: scroll-into-view only fires when the target match actually changes
  // (user pressed next/prev), NOT when `matches` grows during streaming
  // search. We track the (index, blockIndex) tuple instead of just `index`
  // so wrap-around to the same numeric index but a different block still
  // triggers a scroll — e.g. matches.length=3, currentMatch=2; user presses
  // next, modulo wraps to 0, blockIndex differs.
  const lastScrolledMatchRef = useRef<{ index: number; blockIndex: number } | null>(null);
  useEffect(() => {
    applyVisibleHighlights();
    applyCurrentHighlightAndScroll();
    if (matches.length === 0) {
      lastScrolledMatchRef.current = null;
      return;
    }
    const match = matches[currentMatch];
    if (!match) return;
    const prev = lastScrolledMatchRef.current;
    if (prev && prev.index === currentMatch && prev.blockIndex === match.blockIndex) {
      return;
    }
    lastScrolledMatchRef.current = { index: currentMatch, blockIndex: match.blockIndex };
    virtuosoRef.current?.scrollToIndex({
      index: match.blockIndex,
      align: "center",
      behavior: "smooth",
    });
  }, [matches, currentMatch, applyVisibleHighlights, applyCurrentHighlightAndScroll]);

  // ── Imperative handle ─────────────────────────────────────────────────
  useImperativeHandle(
    ref,
    () => ({
      scrollToBlockIndex: (index: number) => {
        virtuosoRef.current?.scrollToIndex({
          index,
          align: "start",
          behavior: "smooth",
        });
      },
      scrollToHeadingId: (id: string) => {
        const heading = headings.find((h) => h.id === id);
        if (!heading) return;
        virtuosoRef.current?.scrollToIndex({
          index: heading.blockIndex,
          align: "start",
          behavior: "smooth",
        });
      },
      setSearchQuery: (q: string) => {
        setQuery(q);
      },
      searchNext: () => {
        // Clear the dedupe ref so length=1 still scrolls: (0+1)%1 === 0,
        // React would bail on identical state, lastScrolledMatchRef would
        // skip the scroll, and pressing "next" with a single match feels
        // dead. Wiping the ref forces the effect to re-scroll the same
        // match into view.
        lastScrolledMatchRef.current = null;
        setCurrentMatch((c) => (matches.length === 0 ? 0 : (c + 1) % matches.length));
      },
      searchPrev: () => {
        lastScrolledMatchRef.current = null;
        setCurrentMatch((c) =>
          matches.length === 0 ? 0 : (c - 1 + matches.length) % matches.length,
        );
      },
    }),
    [headings, matches.length],
  );

  // Map block index → heading id so the wrapper <div> can carry an `id`
  // attribute. Without it, TocPanel's `document.getElementById(headingId)` /
  // IntersectionObserver setup finds nothing (per-block MarkdownRenderer has
  // `enableHeadingIds={false}` to avoid per-block slugger collisions, so the
  // heading <h2>/<h3> elements themselves have no id). Putting the id on the
  // virtualized wrapper keeps the global single-slugger id space and still
  // makes hash navigation + active-heading tracking work.
  const headingIdByBlock = useMemo(() => {
    const m = new Map<number, string>();
    for (const h of headings) m.set(h.blockIndex, h.id);
    return m;
  }, [headings]);

  // ── Rendering ─────────────────────────────────────────────────────────
  const itemContent = useCallback(
    (index: number) => {
      const block = blocks[index];
      if (!block) return null;
      const headingId = headingIdByBlock.get(index);
      // For heading blocks: emit a separate anchor span carrying the id
      // and scroll-margin so hash-nav lands flush with the heading text
      // (not with the wrapper chrome above it). Note: `:target` styling
      // matches THIS span, not the inner h2/h3 — virtualized rendering
      // can't easily put the id on the heading element itself without
      // making per-block sluggers collide. Active-heading tracking
      // (TocPanel + IntersectionObserver) and hash navigation both work
      // off this anchor, which is the primary use case.
      return (
        <div data-virt-block={index} className="px-5">
          {headingId && (
            <span
              id={headingId}
              className="block"
              style={{ scrollMarginTop: "1rem" }}
            />
          )}
          <MarkdownRenderer
            content={block.source}
            onFileClick={onFileClick}
            resolveImageUrl={resolveImageUrl}
            onMermaidClick={onMermaidClick}
            onD2Click={onD2Click}
            onImageClick={onImageClick}
            enableRunCommand={enableRunCommand}
            sketchContext={sketchContext}
            sketchRenderMode={sketchRenderMode}
            location={location}
            // Heading IDs are owned by the virtualized wrapper above (via
            // `id={headingId}` derived from a single global slugger), not by
            // per-block render. Leaving this off avoids the per-block
            // slugger resetting and minting colliding `#setup` ids across
            // multiple blocks.
            enableHeadingIds={false}
          />
        </div>
      );
    },
    [
      blocks,
      headingIdByBlock,
      onFileClick,
      resolveImageUrl,
      onMermaidClick,
      onD2Click,
      onImageClick,
      enableRunCommand,
      sketchContext,
      sketchRenderMode,
      location,
    ],
  );

  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      mountedRangeRef.current = range;
      // Re-run highlights in case our target block just mounted or new
      // blocks scrolled into view. DO NOT scrollIntoView here — rangeChanged
      // fires on every user scroll tick, and scrolling back would steal the
      // user's scroll input.
      applyVisibleHighlights();
      applyCurrentHighlightOnly();
    },
    [applyVisibleHighlights, applyCurrentHighlightOnly],
  );

  return (
    <Virtuoso
      ref={virtuosoRef}
      style={style}
      className={className}
      totalCount={blocks.length}
      itemContent={itemContent}
      increaseViewportBy={{ top: 800, bottom: 1200 }}
      rangeChanged={handleRangeChanged}
      scrollerRef={(el) => onScrollerRef?.(el as HTMLElement | null)}
    />
  );
});
