// Where a comment sits in rendered HTML: how an element is written down, and
// how it is found again after the content around it has changed.
//
// One implementation for every place that pins comments to elements: design
// pages (inside their sandboxed frames), file previews and chat messages.
// The frames get this file as text with the `export` keywords taken off, so
// it stays plain script: no imports, nothing from outside the browser.
//
// `root` is what the paths are measured from: a Document for a whole page, or
// the element that holds the rendered content.

/** The most text an anchor keeps of its element. */
export var ANCHOR_TEXT_LIMIT = 200;

export function cleanText(text, limit) {
  var cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return limit ? cleaned.slice(0, limit) : cleaned;
}

function cssEscape(value) {
  if (typeof window !== 'undefined' && window.CSS && window.CSS.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch.charCodeAt(0).toString(16) + ' '; });
}

function isDocument(root) {
  return root.nodeType === 9;
}

/** How the element reads, as an anchor records it. */
export function anchorText(element) {
  return cleanText(element.innerText || element.textContent, ANCHOR_TEXT_LIMIT);
}

/** A CSS selector for the element, at most six steps long, ending at an id when one is met. */
export function selectorOf(element, root) {
  if (!element || element.nodeType !== 1) return '';
  if (element.id) return '#' + cssEscape(element.id);
  var stop = isDocument(root) ? root.documentElement : root;
  var parts = [];
  while (element && element.nodeType === 1 && element !== stop) {
    if (element.id) { parts.unshift('#' + cssEscape(element.id)); break; }
    var part = element.tagName.toLowerCase();
    var classes = Array.prototype.slice.call(element.classList || [], 0, 2).filter(Boolean);
    if (classes.length) part += '.' + classes.map(cssEscape).join('.');
    var parent = element.parentElement;
    if (parent) {
      var tag = element.tagName;
      var same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === tag; });
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(element) + 1) + ')';
    }
    parts.unshift(part);
    element = parent;
    if (parts.length >= 6) break;
  }
  return parts.join(' > ');
}

/** The element's full path under the root, by tag and position: `/main[1]/p[2]`. */
export function xpathOf(element, root) {
  var stop = isDocument(root) ? null : root;
  var segments = [];
  while (element && element.nodeType === 1 && element !== stop) {
    var index = 1;
    var sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    segments.unshift(element.tagName.toLowerCase() + '[' + index + ']');
    element = element.parentElement;
  }
  return '/' + segments.join('/');
}

/** What is written down of an element so it can be found again. */
export function describeAnchor(element, root) {
  return { selector: selectorOf(element, root), xpath: xpathOf(element, root), text: anchorText(element) };
}

function bySelector(anchor, root) {
  try {
    return anchor.selector ? root.querySelector(anchor.selector) : null;
  } catch (ignored) {
    return null; // a selector the content no longer accepts
  }
}

function byXPath(anchor, root) {
  try {
    if (!anchor.xpath) return null;
    var doc = isDocument(root) ? root : root.ownerDocument;
    // Under an element the path is measured from that element.
    var path = isDocument(root) ? anchor.xpath : '.' + anchor.xpath;
    var node = doc.evaluate(path, root, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
    return node && node.nodeType === 1 ? node : null;
  } catch (ignored) {
    return null;
  }
}

/** Whether the element still reads as the anchor recorded it. Text that was cut short matches by its start. */
function reads(element, text) {
  var now = cleanText(element.innerText || element.textContent);
  return now === text || (text.length >= ANCHOR_TEXT_LIMIT && now.indexOf(text) === 0);
}

// The one element of the anchor's tag that reads as the anchor did: where the
// element went when the content around it was rearranged.
function byText(anchor, root) {
  var tag = /([a-z][a-z0-9-]*)\[\d+\]$/i.exec(anchor.xpath || '');
  if (!tag || !anchor.text) return null;
  var same = Array.prototype.filter.call(root.getElementsByTagName(tag[1]), function (element) {
    return reads(element, anchor.text);
  });
  return same.length === 1 ? same[0] : null;
}

/**
 * Where an anchor's element is now, or null when nothing is left of it. The
 * path and the selector were both recorded; after the content changes either
 * may lead to another element, so the one that still reads as it did is
 * taken. `changed` says none does: the element was rewritten, or this is a
 * different one in its place. An anchor with no `text` is taken as found.
 */
export function locateAnchor(anchor, root) {
  var candidates = [byXPath(anchor, root), bySelector(anchor, root)].filter(Boolean);
  if (typeof anchor.text !== 'string') return candidates.length ? { element: candidates[0], changed: false } : null;
  for (var i = 0; i < candidates.length; i += 1) {
    if (reads(candidates[i], anchor.text)) return { element: candidates[i], changed: false };
  }
  var moved = byText(anchor, root);
  if (moved) return { element: moved, changed: false };
  return candidates.length ? { element: candidates[0], changed: true } : null;
}
