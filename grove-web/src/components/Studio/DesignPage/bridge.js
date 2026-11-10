// Runs inside every design page's sandboxed frame, before the page's own
// scripts. It is the frame's only channel to the Design panel: it reports the
// page's height and a check of the page, resolves the element under the
// pointer for comments, draws the page to an image on request, and hands
// links between pages to the panel.
//
// Loaded as text (`?raw`) and inlined into the frame's srcdoc, so it must stay
// plain script: no imports, and never the closing script tag as a literal.
(function () {
  var config = window.__groveDesign || {};
  var frameId = config.frameId;
  var filesBase = String(config.filesBase || '');
  // The directory above this design's: `…/design/`.
  var designsBase = filesBase.replace(/[^/]+\/$/, '');
  var OVERLAY = 'data-grove-design-overlay';
  var MAX_ISSUES = 8;

  function post(type, data) {
    var message = data || {};
    message.type = 'grove-design:' + type;
    message.frameId = frameId;
    window.parent.postMessage(message, '*');
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  // An opaque origin throws on any storage access; pages and libraries that
  // touch it during startup would otherwise fail before drawing anything.
  function memoryStore() {
    var data = Object.create(null);
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[key]; },
      clear: function () { data = Object.create(null); },
      key: function (index) { return Object.keys(data)[index] || null; },
      get length() { return Object.keys(data).length; },
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try {
      window[name].getItem('__grove_probe__');
    } catch (error) {
      try {
        Object.defineProperty(window, name, { value: memoryStore(), configurable: true });
      } catch (ignored) { /* the page simply has no storage */ }
    }
  });

  // ── What went wrong while loading ─────────────────────────────────────────
  var scriptErrors = [];
  var failedLoads = [];
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && target.nodeType === 1) {
      var url = target.currentSrc || target.src || target.href || '';
      if (url && failedLoads.indexOf(url) < 0) failedLoads.push(url);
    } else if (event.message && scriptErrors.length < MAX_ISSUES) {
      scriptErrors.push(String(event.message));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    if (scriptErrors.length >= MAX_ISSUES) return;
    var reason = event.reason;
    scriptErrors.push('Unhandled promise rejection: ' + String((reason && reason.message) || reason));
  });

  // ── Describing elements ───────────────────────────────────────────────────
  // Shared with the app: see utils/commentAnchor.js, put ahead of this script.
  var anchors = window.__groveAnchor;
  function selectorOf(element) { return anchors.selectorOf(element, document); }
  function xpathOf(element) { return anchors.xpathOf(element, document); }

  function clean(text, limit) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function pageRect(element) {
    var rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function describe(element) {
    var rect = pageRect(element);
    var className = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
    return {
      selector: selectorOf(element),
      xpath: xpathOf(element),
      tagName: element.tagName.toLowerCase(),
      id: element.id || undefined,
      className: clean(className, 160) || undefined,
      role: element.getAttribute('role') || undefined,
      text: anchors.anchorText(element),
      html: clean(element.outerHTML, 300),
      kind: naming(element).kind,
      textOnly: textOnly(element),
      styles: stylesOf(element),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  // ── What the inspector shows ──────────────────────────────────────────────
  var SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, LINK: 1, META: 1, TITLE: 1, BASE: 1, HEAD: 1 };

  function textOnly(element) {
    return element.children.length === 0 && !/^(INPUT|SELECT|TEXTAREA|IMG|SVG|VIDEO|CANVAS|IFRAME|BR|HR)$/i.test(element.tagName)
      && Boolean((element.textContent || '').trim());
  }

  // "Row .toolbar", "Text "No notes yet"": what an element is, and which one.
  function naming(element) {
    var tag = element.tagName.toLowerCase();
    var role = element.getAttribute('role');
    var quoted = function () { var text = clean(element.innerText || element.textContent, 28); return text ? '"' + text + '"' : ''; };
    var named = function () {
      if (element.id) return '#' + element.id;
      var first = element.classList && element.classList[0];
      return first ? '.' + first : tag;
    };
    if (tag === 'button' || role === 'button') return { kind: 'Button', name: quoted() || named() };
    if (tag === 'a') return { kind: 'Link', name: quoted() || named() };
    if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'canvas') return { kind: 'Image', name: clean(element.getAttribute('alt'), 28) || named() };
    if (tag === 'svg') return { kind: 'Icon', name: named() };
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return { kind: 'Input', name: clean(element.getAttribute('placeholder') || element.getAttribute('name'), 28) || named() };
    if (textOnly(element)) return { kind: 'Text', name: quoted() };
    var style = getComputedStyle(element);
    if (style.display.indexOf('grid') >= 0) return { kind: 'Grid', name: named() };
    if (style.display.indexOf('flex') >= 0 && style.flexDirection.indexOf('row') === 0) return { kind: 'Row', name: named() };
    return { kind: 'Column', name: named() };
  }

  function stylesOf(element) {
    var style = getComputedStyle(element);
    var inline = element.style;
    return {
      display: style.display,
      flexDirection: style.flexDirection,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      gap: style.columnGap === style.rowGap ? style.rowGap : style.rowGap + ' ' + style.columnGap,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textAlign: style.textAlign,
      opacity: style.opacity,
      borderRadius: style.borderTopLeftRadius,
      position: style.position,
      flexGrow: style.flexGrow,
      alignSelf: style.alignSelf,
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      marginLeft: inline.marginLeft,
      marginRight: inline.marginRight,
      marginTop: inline.marginTop,
      marginBottom: inline.marginBottom,
      // What the page's author fixed by hand, as opposed to what layout gave.
      inlineWidth: inline.width,
      inlineHeight: inline.height,
      parentDisplay: element.parentElement ? getComputedStyle(element.parentElement).display : '',
      parentDirection: element.parentElement ? getComputedStyle(element.parentElement).flexDirection : '',
    };
  }

  var MAX_NODES = 2500;

  function tree() {
    var budget = { left: MAX_NODES };
    function walk(element, path, depth) {
      var name = naming(element);
      var node = { path: path, kind: name.kind, name: name.name, children: [] };
      if (element.tagName.toLowerCase() === 'svg' || depth > 40) return node;
      var counts = {};
      for (var index = 0; index < element.children.length; index += 1) {
        var child = element.children[index];
        var tag = child.tagName.toLowerCase();
        counts[tag] = (counts[tag] || 0) + 1;
        if (SKIP[child.tagName] || child.hasAttribute(OVERLAY)) continue;
        if (budget.left <= 0) break;
        budget.left -= 1;
        node.children.push(walk(child, path + '/' + tag + '[' + counts[tag] + ']', depth + 1));
      }
      return node;
    }
    return document.body ? walk(document.body, '/html[1]/body[1]', 0).children : [];
  }

  function byPath(path) {
    try {
      var result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue && result.singleNodeValue.nodeType === 1 ? result.singleNodeValue : null;
    } catch (ignored) {
      return null;
    }
  }

  var wantTree = false;
  var treeTimer = 0;
  function postTree() {
    if (wantTree) post('tree', { tree: tree() });
  }
  // The page's own scripts add and remove elements too.
  function watchTree() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(function (records) {
      if (!wantTree) return;
      var ours = records.every(function (record) {
        return record.target.nodeType === 1 && record.target.closest && record.target.closest('[' + OVERLAY + ']');
      });
      if (ours) return;
      clearTimeout(treeTimer);
      treeTimer = setTimeout(function () {
        postTree();
        if (chosenElement && !document.contains(chosenElement)) select(null);
        else if (chosenElement) place(chosen, chosenElement);
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) watchTree();
  else document.addEventListener('DOMContentLoaded', watchTree);

  // ── CSS variables ─────────────────────────────────────────────────────────
  // The values a design is tuned by. Stylesheets cannot be read through the
  // CSSOM from this origin, so their text is fetched and searched.
  function collectVariables() {
    var sources = [];
    var inlineIndex = 0;
    Array.prototype.forEach.call(document.querySelectorAll('style'), function (element) {
      if (element.closest('[' + OVERLAY + ']')) return;
      sources.push(Promise.resolve({ file: '', index: inlineIndex, text: element.textContent || '' }));
      inlineIndex += 1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('link[rel~="stylesheet"][href]'), function (link) {
      var href = link.href.split('#')[0].split('?')[0];
      if (!designsBase || href.indexOf(designsBase) !== 0) return;
      sources.push(fetch(link.href).then(function (response) { return response.ok ? response.text() : ''; })
        .then(function (text) { return { file: decodeURIComponent(href.slice(designsBase.length)), index: 0, text: text }; })
        .catch(function () { return { file: '', index: 0, text: '' }; }));
    });
    Promise.all(sources).then(function (list) {
      var seen = {};
      var found = [];
      var computed = getComputedStyle(document.documentElement);
      list.forEach(function (source) {
        var pattern = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
        var text = source.text.replace(/\/\*[\s\S]*?\*\//g, '');
        var match;
        while ((match = pattern.exec(text)) && found.length < 120) {
          if (seen[match[1]]) continue;
          seen[match[1]] = true;
          var value = match[2].trim();
          var resolved = computed.getPropertyValue(match[1]).trim() || value;
          var kind = window.CSS && CSS.supports && CSS.supports('color', resolved) ? 'color'
            : /^-?[\d.]+(px|rem|em|%)?$/.test(resolved) ? 'length' : 'other';
          found.push({ name: match[1], value: value, resolved: resolved, kind: kind, file: source.file, index: source.index });
        }
      });
      post('variables', { variables: found });
    });
  }

  // ── Changing the page ─────────────────────────────────────────────────────
  // The panel makes the same change to the page's file; this one is so the
  // user sees it at once, without the page loading again.
  function applyEdit(op) {
    var element = byPath(op.path);
    if (!element) return null;
    switch (op.type) {
      case 'text':
        element.textContent = op.value;
        return element;
      case 'style':
        Object.keys(op.props).forEach(function (prop) {
          if (op.props[prop]) element.style.setProperty(prop, op.props[prop]);
          else element.style.removeProperty(prop);
        });
        if (!element.getAttribute('style')) element.removeAttribute('style');
        return element;
      case 'remove':
        element.remove();
        return null;
      case 'duplicate': {
        var copy = element.cloneNode(true);
        copy.removeAttribute('id');
        element.after(copy);
        return copy;
      }
      case 'move': {
        var target = byPath(op.target);
        if (!target || element.contains(target)) return element;
        if (op.place === 'before') target.before(element);
        else if (op.place === 'after') target.after(element);
        else target.appendChild(element);
        return element;
      }
      default:
        return element;
    }
  }

  // ── Checking the page ─────────────────────────────────────────────────────
  function visible(element, style) {
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasOwnText(element) {
    for (var index = 0; index < element.childNodes.length; index += 1) {
      var node = element.childNodes[index];
      if (node.nodeType === 3 && node.textContent.trim()) return true;
    }
    return false;
  }

  function pageHeight() {
    var root = document.documentElement;
    var body = document.body;
    return Math.ceil(Math.max(root.scrollHeight, body ? body.scrollHeight : 0, root.offsetHeight, body ? body.offsetHeight : 0));
  }

  function check() {
    var issues = [];
    var counts = { wide: 0, clipped: 0, overlap: 0 };
    var viewport = document.documentElement.clientWidth;
    var elements = document.body ? document.body.querySelectorAll('*') : [];
    var texts = [];
    var docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
    var tooWide = docWidth > viewport + 1;

    for (var index = 0; index < elements.length && index < 6000; index += 1) {
      var element = elements[index];
      if (element.closest('[' + OVERLAY + ']')) continue;
      var style = getComputedStyle(element);
      if (!visible(element, style)) continue;
      var rect = element.getBoundingClientRect();

      if (tooWide && counts.wide < 3 && rect.right > viewport + 1 && rect.left < viewport && element.children.length === 0) {
        counts.wide += 1;
        issues.push({
          message: 'Sticks out ' + Math.round(rect.right - viewport) + 'px past the right edge of the ' + viewport + 'px viewport',
          selector: selectorOf(element),
        });
      }

      if (hasOwnText(element)) {
        var cutAcross = element.scrollWidth > element.clientWidth + 1 && /hidden|clip/.test(style.overflowX) && style.textOverflow !== 'ellipsis';
        var cutDown = element.scrollHeight > element.clientHeight + 1 && /hidden|clip/.test(style.overflowY)
          && !(style.webkitLineClamp && style.webkitLineClamp !== 'none');
        if ((cutAcross || cutDown) && counts.clipped < MAX_ISSUES) {
          counts.clipped += 1;
          issues.push({
            message: 'Text is cut off: "' + clean(element.innerText || element.textContent, 60) + '"',
            selector: selectorOf(element),
          });
        }
        if (texts.length < 500) texts.push({ element: element, rect: rect });
      }
    }

    if (tooWide) {
      issues.unshift({ message: 'The page is ' + docWidth + 'px wide in a ' + viewport + 'px viewport, so it scrolls sideways' });
    }

    // Text drawn over other text: two text elements, neither inside the
    // other, sharing a good part of the smaller one's box.
    for (var a = 0; a < texts.length && counts.overlap < MAX_ISSUES; a += 1) {
      for (var b = a + 1; b < texts.length && counts.overlap < MAX_ISSUES; b += 1) {
        var first = texts[a];
        var second = texts[b];
        if (first.element.contains(second.element) || second.element.contains(first.element)) continue;
        var width = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left);
        var height = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top);
        if (width <= 2 || height <= 2) continue;
        var smaller = Math.min(first.rect.width * first.rect.height, second.rect.width * second.rect.height);
        if (width * height < smaller * 0.3) continue;
        counts.overlap += 1;
        issues.push({
          message: 'Text overlaps other text: "' + clean(first.element.innerText, 40) + '" and "' + clean(second.element.innerText, 40) + '"',
          selector: selectorOf(first.element),
        });
      }
    }

    Array.prototype.forEach.call(document.images, function (image) {
      var url = image.currentSrc || image.src;
      if (image.complete && image.naturalWidth === 0 && url && failedLoads.indexOf(url) < 0) failedLoads.push(url);
    });
    failedLoads.slice(0, MAX_ISSUES).forEach(function (url) {
      issues.push({ message: 'Failed to load ' + url.replace(designsBase, '') });
    });
    scriptErrors.forEach(function (message) {
      issues.push({ message: 'Script error: ' + clean(message, 200) });
    });
    return { height: pageHeight(), issues: issues };
  }

  // ── Telling the panel the page is ready ───────────────────────────────────
  function settled(done) {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    // Timers, not animation frames: browsers stop animation frames in a
    // frame that is not on screen, and pages are also rendered out of sight.
    var finish = function () { setTimeout(done, 60); };
    // A font that never arrives must not hold the page back.
    Promise.race([fonts, new Promise(function (resolve) { setTimeout(resolve, 3000); })]).then(finish, finish);
  }

  function reportReady() {
    settled(function () {
      setTimeout(function () { post('ready', { report: check() }); }, 150);
    });
  }
  if (document.readyState === 'complete') reportReady();
  else window.addEventListener('load', reportReady);

  // Content that arrives later (a script rendering the page, images) changes
  // the height; the panel decides how far to follow.
  function watchHeight() {
    if (!window.ResizeObserver || !document.body) return;
    var last = 0;
    var observer = new ResizeObserver(function () {
      var height = pageHeight();
      if (chosenElement && chosen) place(chosen, chosenElement);
      if (Math.abs(height - last) > 1) {
        last = height;
        post('height', { height: height });
      }
    });
    observer.observe(document.body);
  }
  if (document.body) watchHeight();
  else document.addEventListener('DOMContentLoaded', watchHeight);

  // ── Picking an element ────────────────────────────────────────────────────
  var picking = false;
  var hover = null;
  var chosen = null;
  var chosenElement = null;
  // How small the page is drawn on the board; outlines keep their weight on screen.
  var shown = 1;

  function select(element) {
    chosenElement = element;
    if (!element) {
      if (chosen) chosen.style.display = 'none';
      return;
    }
    chosen = chosen || box('chosen');
    place(chosen, element);
  }

  function restyle() {
    [hover, chosen].forEach(function (overlay) {
      if (!overlay) return;
      overlay.style.borderWidth = (1.5 / shown) + 'px';
      overlay.style.borderRadius = (3 / shown) + 'px';
      Array.prototype.forEach.call(overlay.children, function (handle) {
        var size = 7 / shown;
        handle.style.width = handle.style.height = size + 'px';
        handle.style.borderWidth = (1.5 / shown) + 'px';
        handle.style.margin = (-size / 2 - 0.75 / shown) + 'px';
      });
    });
  }

  function box(kind) {
    var element = document.createElement('div');
    element.setAttribute(OVERLAY, kind);
    element.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;border:1.5px solid ' + accent() + ';'
      + (kind === 'chosen' ? '' : 'background:' + accent(0.08) + ';');
    if (kind === 'chosen') {
      ['left:0;top:0', 'right:0;top:0', 'left:0;bottom:0', 'right:0;bottom:0'].forEach(function (corner) {
        var handle = document.createElement('div');
        handle.style.cssText = 'position:absolute;box-sizing:border-box;background:#fff;pointer-events:auto;border:1.5px solid ' + accent() + ';' + corner;
        handle.setAttribute('data-grove-handle', corner.indexOf('right') >= 0 ? 'e' : 'w');
        handle.style.cursor = (corner === 'left:0;top:0' || corner === 'right:0;bottom:0') ? 'nwse-resize' : 'nesw-resize';
        element.appendChild(handle);
      });
    }
    document.documentElement.appendChild(element);
    if (kind === 'chosen') chosen = element; else hover = element;
    restyle();
    return element;
  }

  var accentColor = config.accent || '#0d9488';
  function accent(alpha) {
    if (alpha === undefined) return accentColor;
    var hex = accentColor.replace('#', '');
    if (hex.length !== 6) return accentColor;
    return 'rgba(' + parseInt(hex.slice(0, 2), 16) + ',' + parseInt(hex.slice(2, 4), 16) + ',' + parseInt(hex.slice(4, 6), 16) + ',' + alpha + ')';
  }

  function place(overlay, element) {
    var rect = pageRect(element);
    overlay.style.left = rect.x + 'px';
    overlay.style.top = rect.y + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';
  }

  // The thing a person means when they point: not a bare text span or a path
  // inside an icon, but the control or block around it.
  function pickable(target) {
    var element = target && target.nodeType === 1 ? target : target && target.parentElement;
    if (!element || element.closest('[' + OVERLAY + ']')) return null;
    var svg = element.closest('svg');
    if (svg) element = svg;
    var control = element.closest('button, a, input, select, textarea, label, [role="button"], [role="tab"], [role="link"]');
    if (control) return control;
    while (element.parentElement && element !== document.body) {
      var rect = element.getBoundingClientRect();
      var inline = getComputedStyle(element).display.indexOf('inline') === 0;
      if (!inline && rect.width >= 16 && rect.height >= 12) break;
      if (inline && rect.width >= 24 && rect.height >= 12 && element.children.length === 0 && element.parentElement.children.length > 1) break;
      element = element.parentElement;
    }
    return element === document.documentElement ? document.body : element;
  }

  function stop(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  document.addEventListener('mousemove', function (event) {
    if (!picking || gesture) return;
    var element = pickable(event.target);
    if (!element) return;
    hover = hover || box('hover');
    place(hover, element);
  }, true);

  document.addEventListener('mouseleave', function () {
    if (hover) hover.style.display = 'none';
  }, true);

  ['mousedown', 'mouseup'].forEach(function (name) {
    document.addEventListener(name, function (event) { if (picking) stop(event); }, true);
  });

  // ── Resizing and moving the chosen element ────────────────────────────────
  // Dragging a corner sets the element's width and height. Dragging the
  // element itself moves it: to another place among the elements when it is
  // laid out with them, or by its left and top when it is positioned.
  var editable = false;
  var gesture = null;
  var justDragged = false;
  var dropLine = null;

  function dropTarget(x, y) {
    var under = document.elementFromPoint(x, y);
    var target = pickable(under);
    // Over one of its own siblings, or something inside one: the usual wish is
    // to change the order, not to move into that sibling.
    for (var up = target; up && up !== document.body; up = up.parentElement) {
      if (up.parentElement === chosenElement.parentElement) { target = up; break; }
    }
    if (!target || target === document.body || chosenElement.contains(target) || !target.parentElement) return null;
    var rect = target.getBoundingClientRect();
    // Side by side with a neighbour (a row, a grid, inline flow): the place is left or right of it.
    var neighbour = target.nextElementSibling || target.previousElementSibling;
    var beside = neighbour && !neighbour.hasAttribute(OVERLAY) ? neighbour.getBoundingClientRect() : null;
    var across = Boolean(beside) && Math.abs(beside.top - rect.top) < rect.height / 2 && Math.abs(beside.left - rect.left) > 1;
    var before = across ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
    // An empty box takes the element in, when the pointer is well inside it.
    var inside = target.children.length === 0 && !textOnly(target) && /^(Row|Column|Grid)$/.test(naming(target).kind)
      && x > rect.left + rect.width * 0.25 && x < rect.right - rect.width * 0.25
      && y > rect.top + rect.height * 0.25 && y < rect.bottom - rect.height * 0.25;
    return { element: target, place: inside ? 'inside' : before ? 'before' : 'after', across: across, rect: rect };
  }

  function showDrop(drop) {
    if (!dropLine) {
      dropLine = document.createElement('div');
      dropLine.setAttribute(OVERLAY, 'drop');
      dropLine.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483647;background:' + accent() + ';display:none;';
      document.documentElement.appendChild(dropLine);
    }
    if (!drop) { dropLine.style.display = 'none'; return; }
    var thick = 2 / shown;
    var rect = drop.rect;
    var left = rect.left + window.scrollX;
    var top = rect.top + window.scrollY;
    dropLine.style.display = 'block';
    dropLine.style.opacity = drop.place === 'inside' ? '0.25' : '1';
    if (drop.place === 'inside') {
      dropLine.style.left = left + 'px';
      dropLine.style.top = top + 'px';
      dropLine.style.width = rect.width + 'px';
      dropLine.style.height = rect.height + 'px';
    } else if (drop.across) {
      dropLine.style.left = (drop.place === 'before' ? left - thick : left + rect.width) + 'px';
      dropLine.style.top = top + 'px';
      dropLine.style.width = thick + 'px';
      dropLine.style.height = rect.height + 'px';
    } else {
      dropLine.style.left = left + 'px';
      dropLine.style.top = (drop.place === 'before' ? top - thick : top + rect.height) + 'px';
      dropLine.style.width = rect.width + 'px';
      dropLine.style.height = thick + 'px';
    }
  }

  document.addEventListener('pointerdown', function (event) {
    if (!picking) return;
    stop(event);
    gesture = null;
    if (!editable || event.button !== 0 || !chosenElement) return;
    var corner = event.target.getAttribute && event.target.getAttribute('data-grove-handle');
    var rect = chosenElement.getBoundingClientRect();
    if (corner) {
      gesture = { kind: 'resize', corner: corner, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, top: event.target.style.top === '0px' };
    } else if (chosenElement !== document.body && chosenElement.contains(event.target)) {
      var position = getComputedStyle(chosenElement).position;
      gesture = {
        kind: /absolute|fixed/.test(position) ? 'place' : 'move',
        x: event.clientX, y: event.clientY, left: chosenElement.offsetLeft, top: chosenElement.offsetTop,
      };
    }
    if (gesture) { try { event.target.setPointerCapture(event.pointerId); } catch (ignored) { /* the gesture still works inside the page */ } }
  }, true);

  document.addEventListener('pointermove', function (event) {
    if (!gesture) return;
    var dx = event.clientX - gesture.x;
    var dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    gesture.moved = true;
    if (hover) hover.style.display = 'none';
    if (gesture.kind === 'resize') {
      gesture.props = {};
      if (Math.abs(dx) > 1) gesture.props.width = Math.max(4, Math.round(gesture.width + (gesture.corner === 'e' ? dx : -dx))) + 'px';
      if (Math.abs(dy) > 1) gesture.props.height = Math.max(4, Math.round(gesture.height + (gesture.top ? -dy : dy))) + 'px';
      Object.keys(gesture.props).forEach(function (prop) { chosenElement.style.setProperty(prop, gesture.props[prop]); });
      place(chosen, chosenElement);
    } else if (gesture.kind === 'place') {
      gesture.props = { left: Math.round(gesture.left + dx) + 'px', top: Math.round(gesture.top + dy) + 'px' };
      chosenElement.style.left = gesture.props.left;
      chosenElement.style.top = gesture.props.top;
      chosenElement.style.right = chosenElement.style.bottom = 'auto';
      gesture.props.right = gesture.props.bottom = 'auto';
      place(chosen, chosenElement);
    } else {
      gesture.drop = dropTarget(event.clientX, event.clientY);
      showDrop(gesture.drop);
    }
  }, true);

  function endGesture(event) {
    if (picking) stop(event);
    var done = gesture;
    gesture = null;
    showDrop(null);
    if (!done || !done.moved) return;
    justDragged = true;
    setTimeout(function () { justDragged = false; }, 0);
    if (done.kind === 'move') {
      if (done.drop) post('moved', { path: xpathOf(chosenElement), target: xpathOf(done.drop.element), place: done.drop.place });
    } else if (done.props) {
      post('changed', { props: done.props });
    }
  }
  document.addEventListener('pointerup', endGesture, true);
  document.addEventListener('pointercancel', endGesture, true);

  document.addEventListener('click', function (event) {
    if (picking) {
      stop(event);
      if (justDragged) return;
      var element = pickable(event.target);
      if (!element) return;
      if (hover) hover.style.display = 'none';
      select(element);
      post('selected', { anchor: describe(element) });
      return;
    }
    followLink(event);
  }, true);

  document.addEventListener('keydown', function (event) {
    // Undo belongs to the board while elements are being chosen, not to the page.
    if (picking && (event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'z'
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || '')) {
      event.preventDefault();
      post('undo', { redo: event.shiftKey });
      return;
    }
    if (event.key === 'Escape') post('escape');
  }, true);

  // ── Links ─────────────────────────────────────────────────────────────────
  // The frame is a srcdoc with a <base>, so a followed link would leave it for
  // the bare file. Links to other pages go to the panel, which swaps the page;
  // in-page anchors scroll; anything else opens outside Grove.
  function followLink(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var raw = link.getAttribute('href') || '';
    if (raw.charAt(0) === '#') {
      event.preventDefault();
      var target = raw.length > 1 ? document.getElementById(decodeURIComponent(raw.slice(1))) : null;
      if (target) post('scroll', { y: pageRect(target).y });
      return;
    }
    var url;
    try { url = new URL(link.href); } catch (ignored) { return; }
    if (designsBase && url.href.indexOf(designsBase) === 0) {
      event.preventDefault();
      var path = decodeURIComponent(url.pathname.slice(new URL(designsBase).pathname.length)).split('/');
      if (path.length === 2 && /\.html$/i.test(path[1])) {
        post('navigate', { design: path[0], file: path[1], hash: url.hash.slice(1) });
      }
      return;
    }
    if (/^https?:$/.test(url.protocol)) link.target = '_blank';
  }

  // ── Scrolling on the board ────────────────────────────────────────────────
  // On the board the page is as tall as its content, so a scroll over it is
  // meant for the board. A list or pane inside the page that can still scroll
  // that way keeps the scroll.
  var forwardWheel = false;

  function scrollsInside(element, dx, dy) {
    while (element && element.nodeType === 1 && element !== document.body && element !== document.documentElement) {
      var style = getComputedStyle(element);
      if (dy && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        && (dy < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)) return true;
      if (dx && /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1
        && (dx < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1)) return true;
      element = element.parentElement;
    }
    return false;
  }

  window.addEventListener('wheel', function (event) {
    if (!forwardWheel) return;
    var zoom = event.ctrlKey || event.metaKey;
    if (!zoom && scrollsInside(event.target, event.deltaX, event.deltaY)) return;
    event.preventDefault();
    var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    post('wheel', {
      deltaX: event.deltaX * unit,
      deltaY: event.deltaY * unit,
      zoom: zoom,
      x: event.clientX + window.scrollX,
      y: event.clientY + window.scrollY,
    });
  }, { passive: false, capture: true });

  // ── Requests from the panel ───────────────────────────────────────────────
  var screenshotLoaded = false;

  function draw(message) {
    try {
      if (!screenshotLoaded) {
        (0, eval)(message.library);
        screenshotLoaded = true;
      }
      var hidden = document.querySelectorAll('[' + OVERLAY + ']');
      Array.prototype.forEach.call(hidden, function (element) { element.style.visibility = 'hidden'; });
      // The library works out default styles in a scratch frame it creates,
      // then reads that frame's document. In this sandbox every frame has its
      // own origin, so that read fails. Refusing the frame makes the library
      // copy every computed style instead, which is what we want anyway.
      var createElement = document.createElement;
      document.createElement = function (name) {
        if (String(name).toLowerCase() === 'iframe') throw new Error('No scratch frame in a sandboxed page');
        return createElement.apply(document, arguments);
      };
      var restore = function () {
        document.createElement = createElement;
        Array.prototype.forEach.call(hidden, function (element) { element.style.visibility = ''; });
      };
      var width = document.documentElement.clientWidth;
      var height = Math.min(pageHeight(), message.maxHeight || 6000);
      window.modernScreenshot.domToPng(document.documentElement, {
        width: width,
        height: height,
        scale: 1,
        backgroundColor: getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)'
          && getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : null,
        timeout: 15000,
        filter: function (node) { return !(node.nodeType === 1 && node.hasAttribute(OVERLAY)); },
      }).then(function (dataUrl) {
        restore();
        post('captured', { requestId: message.requestId, image: dataUrl, report: check(), height: height });
      }, function (error) {
        restore();
        post('captured', { requestId: message.requestId, report: check(), error: String((error && error.message) || error) });
      });
    } catch (error) {
      post('captured', { requestId: message.requestId, report: check(), error: String((error && error.message) || error) });
    }
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (event.source !== window.parent || message.frameId !== frameId) return;
    switch (message.type) {
      case 'grove-design:pick':
        picking = Boolean(message.on);
        document.documentElement.style.cursor = picking ? 'crosshair' : '';
        if (!picking && hover) hover.style.display = 'none';
        break;
      case 'grove-design:forward-wheel':
        forwardWheel = Boolean(message.on);
        break;
      case 'grove-design:clear':
        select(null);
        break;
      case 'grove-design:scale':
        shown = Number(message.k) > 0 ? Number(message.k) : 1;
        restyle();
        break;
      case 'grove-design:tree':
        wantTree = Boolean(message.on);
        postTree();
        if (wantTree) collectVariables();
        break;
      case 'grove-design:editable':
        editable = Boolean(message.on);
        break;
      case 'grove-design:variable':
        if (message.value) document.documentElement.style.setProperty(message.name, message.value);
        else document.documentElement.style.removeProperty(message.name);
        if (chosenElement && chosen) place(chosen, chosenElement);
        break;
      case 'grove-design:select': {
        var wanted = byPath(message.path);
        select(wanted);
        if (wanted) post('selected', { anchor: describe(wanted) });
        break;
      }
      case 'grove-design:edit': {
        var after = applyEdit(message.op);
        select(after && document.contains(after) ? after : null);
        postTree();
        post('edited', { anchor: chosenElement ? describe(chosenElement) : null });
        break;
      }
      case 'grove-design:locate': {
        var boxes = {};
        (message.anchors || []).forEach(function (anchor) {
          var found = anchors.locateAnchor(anchor, document);
          if (!found) { boxes[anchor.id] = { missing: true }; return; }
          boxes[anchor.id] = pageRect(found.element);
          if (found.changed) boxes[anchor.id].changed = true;
        });
        post('located', { boxes: boxes });
        break;
      }
      case 'grove-design:capture':
        draw(message);
        break;
      default:
        break;
    }
  });
})();
