/** What is written down of an element so a comment on it can be found again. */
export interface CommentAnchor {
  selector?: string;
  xpath?: string;
  /** How the element read when the comment was made; absent on old anchors. */
  text?: string;
}

export const ANCHOR_TEXT_LIMIT: number;
export function cleanText(text: unknown, limit?: number): string;
export function anchorText(element: Element): string;
export function selectorOf(element: Element, root: Document | Element): string;
export function xpathOf(element: Element, root: Document | Element): string;
export function describeAnchor(element: Element, root: Document | Element): Required<CommentAnchor>;
/** `changed`: the element no longer reads as it did when the comment was made. */
export function locateAnchor(anchor: CommentAnchor, root: Document | Element): { element: Element; changed: boolean } | null;
