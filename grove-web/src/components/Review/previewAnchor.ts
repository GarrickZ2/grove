import type { PreviewCommentLocator } from '../../context';
import { locateAnchor } from '../../utils/commentAnchor';

/** Where a comment on a preview is now. */
export interface LocatedComment {
  elements: Element[];
  /** The selected text, when the comment is on a selection that is still there. */
  range: Range | null;
  /** What it was on has been rewritten. */
  stale: boolean;
}

interface Marker {
  selector?: string;
  xpath?: string;
  extraBlocks?: PreviewCommentLocator['extraBlocks'];
  locator?: PreviewCommentLocator;
}

/** How much of the text around a selection must be the same for it to count as the same place in another block. */
const SAME_PLACE = 12;

/** The most text kept on each side of a selection. */
export const SELECTION_CONTEXT = 40;

export function textRangeForOffsets(element: Element, start: number, end: number): Range | null {
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

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (!quote) return found;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
}

/** How many characters two texts share from their ends (`back`) or starts. */
function sharedLength(a: string, b: string, back: boolean): number {
  const most = Math.min(a.length, b.length);
  for (let i = 0; i < most; i += 1) {
    if (back ? a[a.length - 1 - i] !== b[b.length - 1 - i] : a[i] !== b[i]) return i;
  }
  return most;
}

function quoteIn(element: Element, at: number, quote: string): Range | null {
  const range = textRangeForOffsets(element, at, at + quote.length);
  return range?.toString() === quote ? range : null;
}

/** The selection within its own block: of several, the one with the recorded
 *  text around it, then the one nearest to where it was. */
function selectionIn(element: Element, textRange: NonNullable<PreviewCommentLocator['textRange']>, least = 0): Range | null {
  const { start, quote, before = '', after = '' } = textRange;
  const text = element.textContent ?? '';
  const score = (at: number) =>
    sharedLength(text.slice(Math.max(0, at - SELECTION_CONTEXT), at), before, true)
    + sharedLength(text.slice(at + quote.length, at + quote.length + SELECTION_CONTEXT), after, false);
  const best = occurrences(text, quote)
    .map((at) => ({ at, score: score(at) }))
    .sort((a, b) => b.score - a.score || Math.abs(a.at - start) - Math.abs(b.at - start))[0];
  return best && best.score >= least ? quoteIn(element, best.at, quote) : null;
}

/** Find a selection again: in its block, else the one place around it that
 *  still says the same. A quote found in several places is left alone. */
export function textRangeForLocator(element: Element, locator: PreviewCommentLocator, stop: Element): Range | null {
  const { textRange } = locator;
  if (!textRange) return null;
  const inside = selectionIn(element, textRange);
  if (inside) return inside;
  for (let cur: Element | null = element.parentElement; cur && stop.contains(cur); cur = cur.parentElement) {
    const found = occurrences(cur.textContent ?? '', textRange.quote);
    if (found.length > 1) return null;
    if (found.length === 1) return quoteIn(cur, found[0], textRange.quote);
    if (cur === stop) break;
  }
  return null;
}

/** Text without its spacing, which rendering and `textContent` set differently. */
function bare(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Where the comment is now, or null when nothing of what it was on is left:
 *  a comment is never drawn on something else that took its place. */
export function locateComment(marker: Marker, content: Element): LocatedComment | null {
  const { locator } = marker;
  const extras = marker.extraBlocks ?? [];
  const several = extras.length > 0;
  const selection = locator?.textRange;
  const text = locator?.blockText ?? (several || selection ? undefined : locator?.text);
  const head = locateAnchor({ selector: marker.selector, xpath: marker.xpath, text }, content);
  const block = head && !head.guess ? head.element : null;

  if (selection) {
    if (locator.blockText !== undefined) {
      // Its own block, or where the same words stand in the same text around them.
      const range = selectionIn(block ?? content, selection, block ? 0 : SAME_PLACE);
      if (range) return { elements: [block ?? content], range, stale: false };
      return block ? { elements: [block], range: null, stale: true } : null;
    }
    // Old comments know only the path and the words: without the words there,
    // the one place in the file that has them, or nothing.
    const range = textRangeForLocator(block ?? content, locator, content);
    const unsure = !block && occurrences(content.textContent ?? '', selection.quote).length !== 1;
    return range && !unsure ? { elements: [block ?? content], range, stale: false } : null;
  }
  if (!block) return null;
  if (!several) return { elements: [block], range: null, stale: Boolean(head?.changed) };

  // Old comments on several blocks kept only their joined text: it has to start as the first one reads.
  if (locator?.text && locator.blockText === undefined && !bare(locator.text).startsWith(bare(block.textContent ?? '').slice(0, 60))) return null;
  const elements = [block];
  let stale = Boolean(head?.changed);
  for (const extra of extras) {
    const found = locateAnchor(extra, content);
    if (!found || found.guess) continue;
    elements.push(found.element);
    stale = stale || found.changed;
  }
  return { elements, range: null, stale };
}
