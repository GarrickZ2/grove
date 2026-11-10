/** What the source element must look like for an edit to be about the same element. */
export interface EditCheck {
  tag: string;
  id?: string;
  /** The element's first class. */
  cls?: string;
}

/** One change to a page, addressed by the element's XPath. */
export type DesignEdit = { check?: EditCheck } & (
  | { type: "text"; path: string; value: string }
  /** CSS properties to set inline; an empty value removes one. */
  | { type: "style"; path: string; props: Record<string, string> }
  | { type: "remove"; path: string }
  | { type: "duplicate"; path: string }
  | { type: "move"; path: string; target: string; place: "before" | "after" | "inside" }
);

export function checkOf(element: { tagName: string; id?: string; className?: string }): EditCheck {
  return { tag: element.tagName.toLowerCase(), id: element.id || undefined, cls: element.className?.split(/\s+/).find(Boolean) };
}

function byPath(doc: Document, path: string): Element | null {
  try {
    const node = doc.evaluate(path, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    return node instanceof Element || (node && node.nodeType === 1) ? (node as Element) : null;
  } catch {
    return null;
  }
}

function matches(element: Element, check: EditCheck | undefined): boolean {
  if (!check) return true;
  if (element.tagName.toLowerCase() !== check.tag) return false;
  if ((element.id || undefined) !== check.id) return false;
  return !check.cls || element.classList.contains(check.cls);
}

function applyOne(doc: Document, op: DesignEdit): boolean {
  const element = byPath(doc, op.path);
  if (!element || !matches(element, op.check)) return false;
  switch (op.type) {
    case "text":
      element.textContent = op.value;
      return true;
    case "style": {
      const style = (element as HTMLElement).style;
      for (const [prop, value] of Object.entries(op.props)) {
        if (value) style.setProperty(prop, value);
        else style.removeProperty(prop);
      }
      if (!element.getAttribute("style")) element.removeAttribute("style");
      return true;
    }
    case "remove":
      element.remove();
      return true;
    case "duplicate": {
      const copy = element.cloneNode(true) as Element;
      copy.removeAttribute("id");
      element.after(copy);
      return true;
    }
    case "move": {
      const target = byPath(doc, op.target);
      if (!target || element.contains(target)) return false;
      if (op.place === "before") target.before(element);
      else if (op.place === "after") target.after(element);
      else target.appendChild(element);
      return true;
    }
  }
}

/**
 * A page's HTML with the edits made, in order. Null when an edit's element is
 * not in the file as the page shows it: the page's own script drew it, so only
 * a change to that script can change it.
 */
export function applyEdits(html: string, edits: DesignEdit[]): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const edit of edits) {
    if (!applyOne(doc, edit)) return null;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].trim() ?? "<!DOCTYPE html>";
  return `${doctype}\n${doc.documentElement.outerHTML}\n`;
}

/** A stylesheet with one variable's first definition set to `value`. Null when it defines no such variable. */
export function setCssVariable(css: string, name: string, value: string): string | null {
  // The name on its own, not the end of a longer one; the last declaration of a block may have no `;`.
  const pattern = new RegExp(`(^|[^\\w-])(${name.replace(/[^\w-]/g, "")}\\s*:\\s*)[^;{}]*[^;{}\\s]`);
  return pattern.test(css) ? css.replace(pattern, (_, before: string, head: string) => `${before}${head}${value}`) : null;
}

/** The same in a page's own `<style>`; `index` counts the page's style elements. */
export function setPageVariable(html: string, index: number, name: string, value: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const style = doc.querySelectorAll("style")[index];
  const next = style ? setCssVariable(style.textContent ?? "", name, value) : null;
  if (!style || next === null) return null;
  style.textContent = next;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].trim() ?? "<!DOCTYPE html>";
  return `${doctype}\n${doc.documentElement.outerHTML}\n`;
}

/** `rgb(24, 24, 27)` → `#18181b`; null for anything a color well cannot show. */
export function toHex(color: string): string | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color.trim());
  if (!match) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : null;
  if (match[4] !== undefined && Number(match[4]) === 0) return null;
  return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

/** `12px` → `12`; other values as they are. */
export function px(value: string | undefined): string {
  if (!value) return "";
  const match = /^(-?[\d.]+)px$/.exec(value);
  return match ? String(Math.round(Number(match[1]) * 100) / 100) : value;
}

/** What the user typed for a length: a bare number means pixels. */
export function length(value: string): string {
  const text = value.trim();
  return /^-?[\d.]+$/.test(text) ? `${text}px` : text;
}
