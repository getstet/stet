// The preview agent: injected by `stet dev` into every page its preview shows.
// It finds where a content key renders, outlines it in amber and scrolls it
// into view, and shows the operator's unsaved draft in place of the rendered
// text. It talks to the dashboard by postMessage alone, accepts messages only
// from the dashboard window that framed it, carries the run's preview channel
// on every message it sends so the dashboard can tell it from a page the frame
// navigated to, and never sees the run token. No dependencies; it runs in any
// page.
(function () {
  'use strict';
  var script = document.currentScript;
  var parentOrigin = script && script.getAttribute('data-parent');
  var channel = script && script.getAttribute('data-channel');
  if (!parentOrigin || !channel || window.parent === window) return;
  // One agent per page: a second copy (a fragment the page fetched, or head
  // scripts a site re-runs on navigation) leaves the first one answering.
  if (window.__stetPreviewAgent) return;
  window.__stetPreviewAgent = true;

  // Solid where stet knows the element renders the key (a mark, or a text
  // match a save has confirmed); dashed where a text match is a guess.
  var SOLID = '2px solid hsl(38 92% 50%)';
  var DASHED = '2px dashed hsl(38 92% 50%)';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var marked = [];   // [{ el, outline, offset }]
  var swapped = [];  // [{ node, text }] or [{ el, attr, text }]
  var last = null;   // the last locate request, re-applied after the page re-renders
  var opened = [];   // the closed <details> this script opened; a visitor's own are never in it
  var declined = []; // ones it opened that another hand closed again, left closed until the key is picked anew

  var norm = function (text) { return String(text).replace(/\s+/g, ' ').trim(); };
  var tell = function (message) {
    message.channel = channel;
    window.parent.postMessage(message, parentOrigin);
  };

  /**
   * A value as a test over rendered text: `{{name}}` matches any non-empty run,
   * placeholder tags none. The literal pieces are found in order with
   * `indexOf`, leftmost first, so a near miss costs one pass over the text
   * however many variables the value holds.
   */
  function pattern(value) {
    var plain = norm(String(value).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
    if (plain === '') return null;
    var parts = plain.split(/\{\{\s*[\w.]+\s*\}\}/);
    var first = parts[0];
    var tail = parts[parts.length - 1];
    return {
      test: function (text) {
        if (parts.length === 1) return text === plain;
        if (text.slice(0, first.length) !== first || text.slice(text.length - tail.length) !== tail) return false;
        var at = first.length;
        for (var i = 1; i < parts.length - 1; i += 1) {
          var found = text.indexOf(parts[i], at + 1);
          if (found === -1) return false;
          at = found + parts[i].length;
        }
        return text.length - tail.length >= at + 1;
      },
    };
  }

  /** Put back every outline and swapped text; the <details> this script opened close too, unless `keepOpen` (a new request settles them). */
  function clear(keepOpen) {
    endSettle();
    marked.forEach(function (m) { m.el.style.outline = m.outline; m.el.style.outlineOffset = m.offset; });
    swapped.forEach(function (s) {
      if (s.node) s.node.data = s.text;
      else s.el.setAttribute(s.attr, s.text);
    });
    marked = [];
    swapped = [];
    if (!keepOpen) closeOpened([]);
    settle();
  }

  /** Close each <details> this script opened that `keep` does not hold. */
  function closeOpened(keep) {
    opened = opened.filter(function (d) {
      if (keep.indexOf(d) !== -1) return true;
      d.removeAttribute('open');
      return false;
    });
  }

  /**
   * Open every closed <details> around `el`, other than one whose summary
   * holds it, so a key inside a closed disclosure can be seen; each one this
   * script opened, now or for an earlier request, goes into `needed`. One it
   * opened that is closed again was closed by the page or the visitor: it
   * leaves the list and stays closed, so a page that closes it on toggle is
   * not reopened by every re-apply.
   */
  function disclose(el, needed) {
    for (var d = el.parentElement; d; d = d.parentElement) {
      if (d.tagName !== 'DETAILS') continue;
      var summary = null;
      for (var c = d.firstElementChild; c && summary === null; c = c.nextElementSibling) if (c.tagName === 'SUMMARY') summary = c;
      if (summary && summary.contains(el)) continue;
      var ours = opened.indexOf(d) !== -1;
      if (ours && !d.hasAttribute('open')) {
        opened.splice(opened.indexOf(d), 1);
        declined.push(d);
        continue;
      }
      if (declined.indexOf(d) !== -1) continue;
      if (!d.hasAttribute('open')) {
        d.setAttribute('open', '');
        if (!ours) opened.push(d);
        ours = true;
      }
      if (ours) needed.push(d);
    }
  }

  /** Whether the page renders `el` where no one can see it: no box, or a box of no size. */
  function hiddenEl(el) {
    var box = el.getBoundingClientRect();
    return el.getClientRects().length === 0 || (box.width === 0 && box.height === 0);
  }

  /**
   * A hit hidden at the moment it is found may only be on its way in: an
   * entrance animation or transition on it or an ancestor, or a frame not laid
   * out yet. `ask` is asked again on every `animationend` and `transitionend`
   * whose target is a hit or holds one, and a last time after SETTLE_MS with
   * `final` set; the wait ends at the first answer of true. A new locate, a
   * clear and a page leaving the frame end the wait.
   */
  var SETTLE_MS = 1000;
  var unsettle = null;
  function whenSettled(els, ask) {
    // Its one caller, `locate`, has already ended any earlier wait through `clear`.
    var onEnd = function (event) {
      var target = event.target;
      if (!els.some(function (el) { return target === el || (target.contains && target.contains(el)); })) return;
      if (ask(false)) endSettle();
    };
    var timer = setTimeout(function () { endSettle(); ask(true); }, SETTLE_MS);
    document.addEventListener('animationend', onEnd, true);
    document.addEventListener('transitionend', onEnd, true);
    unsettle = function () {
      clearTimeout(timer);
      document.removeEventListener('animationend', onEnd, true);
      document.removeEventListener('transitionend', onEnd, true);
    };
  }
  function endSettle() {
    if (unsettle !== null) unsettle();
    unsettle = null;
  }

  /**
   * Centre `el` inside the frame's own document: in every scrolling ancestor
   * by `scrollTop`, innermost first, then in the frame's window.
   * `scrollIntoView` would also scroll the dashboard around the frame.
   */
  function scrollToCentre(el) {
    for (var box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
      var overflow = getComputedStyle(box).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && box.scrollHeight > box.clientHeight) {
        var inner = el.getBoundingClientRect();
        box.scrollTop += inner.top - (box.getBoundingClientRect().top + box.clientTop) - (box.clientHeight - inner.height) / 2;
      }
    }
    var at = el.getBoundingClientRect();
    // Instant: a site's own `scroll-behavior: smooth` would otherwise animate it.
    window.scrollTo({ top: Math.max(0, at.top + window.scrollY - (window.innerHeight - at.height) / 2), behavior: 'instant' });
  }

  /** The elements a key is marked on (static-HTML host), as [{ el, attr }]; attr null for the text. */
  function byMark(key) {
    var found = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (el.getAttribute('data-stet') === key) found.push({ el: el, attr: null });
      for (var j = 0; j < el.attributes.length; j += 1) {
        var a = el.attributes[j];
        if (a.name.indexOf('data-stet-') === 0 && a.value === key) found.push({ el: el, attr: a.name.slice('data-stet-'.length) });
      }
    }
    return found;
  }

  /** A matcher over rendered text: the index of the first of `texts` a text equals, or -1. */
  function matcher(texts) {
    var patterns = texts.map(pattern);
    if (!patterns.some(Boolean) || !document.body) return null;
    return function (text) {
      var t = norm(text);
      if (t === '') return -1;
      for (var i = 0; i < patterns.length; i += 1) if (patterns[i] && patterns[i].test(t)) return i;
      return -1;
    };
  }

  /** Text nodes holding the whole of one of `texts`, each hit carrying `index`, the text it matched. */
  function byNode(texts) {
    var which = matcher(texts);
    if (which === null) return [];
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      var at = parent && !SKIP[parent.tagName] ? which(node.data) : -1;
      if (at !== -1) nodes.push({ el: parent, attr: null, node: node, index: at });
    }
    return nodes;
  }

  /** Text split across inline elements: the deepest elements whose whole text is one of `texts`. */
  function byElement(texts) {
    var which = matcher(texts);
    if (which === null) return [];
    var found = [];
    var all = document.body.querySelectorAll('*');
    for (var i = all.length - 1; i >= 0; i -= 1) {
      var el = all[i];
      if (SKIP[el.tagName]) continue;
      var index = which(el.textContent);
      if (index === -1 || found.some(function (f) { return el.contains(f.el); })) continue;
      found.push({ el: el, attr: null, index: index });
    }
    return found;
  }

  // A value shorter than this is too likely to occur inside unrelated text.
  var CONTAINED_MIN = 12;

  /**
   * Text nodes holding one of `texts` inside more text of their own, word-bounded
   * on both sides: a template that wraps the value ("…, today") still shows
   * where it renders. Each occurrence is a hit carrying the node, the
   * occurrence's `pattern` and `index`. A value under `CONTAINED_MIN`
   * characters, or holding a `{{name}}`, is never searched this way.
   */
  function byContained(texts) {
    var patterns = texts.map(function (text) {
      var plain = norm(String(text).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
      if (plain.length < CONTAINED_MIN || /\{\{/.test(plain)) return null;
      var body = plain.split(' ').map(function (word) { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('\\s+');
      return new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'gu');
    });
    if (!patterns.some(Boolean) || !document.body) return [];
    var hits = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      if (!parent || SKIP[parent.tagName]) continue;
      for (var i = 0; i < patterns.length; i += 1) {
        if (!patterns[i]) continue;
        patterns[i].lastIndex = 0;
        while (patterns[i].exec(node.data) !== null) hits.push({ el: parent, attr: null, node: node, pattern: patterns[i], index: i });
      }
    }
    return hits;
  }

  /** Swap the draft in for every contained occurrence in one node at once, keeping the node's other text. */
  function draftContained(hit, draft) {
    if (swapped.some(function (s) { return s.node === hit.node; })) return true;
    swapped.push({ node: hit.node, text: hit.node.data });
    hit.node.data = hit.node.data.replace(hit.pattern, function () { return draft; });
    return true;
  }

  /** Swap the draft in where it maps onto one text: a matched text node, an element holding text alone, or a marked attribute. */
  function draftInto(hit, draft) {
    if (hit.node) {
      var edges = /^(\s*)[\s\S]*?(\s*)$/.exec(hit.node.data);
      swapped.push({ node: hit.node, text: hit.node.data });
      hit.node.data = edges[1] + draft + edges[2];
      return true;
    }
    if (hit.attr) {
      swapped.push({ el: hit.el, attr: hit.attr, text: hit.el.getAttribute(hit.attr) });
      hit.el.setAttribute(hit.attr, draft);
      return true;
    }
    var nodes = hit.el.childNodes;
    for (var i = 0; i < nodes.length; i += 1) if (nodes[i].nodeType !== 3) return false;
    if (nodes.length === 0) return false;
    swapped.push({ node: nodes[0], text: nodes[0].data });
    for (var j = 1; j < nodes.length; j += 1) swapped.push({ node: nodes[j], text: nodes[j].data });
    nodes[0].data = draft;
    for (var k = 1; k < nodes.length; k += 1) nodes[k].data = '';
    return true;
  }

  /**
   * A draft carrying numbered placeholder tags, on the element a key is marked
   * on: the tags number the element's descendants depth-first, as the value
   * does, and each run of text between two tags replaces the text between the
   * same two element boundaries, so the draft shows in the page's own styling.
   * It maps only when the draft's tags come in the order the element's do and
   * every non-empty run has a text node to go into; the first run keeps the
   * element's leading whitespace and the last its trailing whitespace. Returns
   * false, changing nothing, when the draft does not map.
   */
  function draftTagged(el, draft) {
    var number = new Map();
    var all = el.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) number.set(all[i], i + 1);
    var boundaries = [];
    var slots = [[]];
    var walk = function (node) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) { slots[slots.length - 1].push(child); continue; }
        if (child.nodeType !== 1) continue;
        var n = number.get(child);
        if (child.firstElementChild === null && norm(child.textContent) === '') {
          boundaries.push('<' + n + '/>');
          slots.push([]);
          continue;
        }
        boundaries.push('<' + n + '>');
        slots.push([]);
        walk(child);
        boundaries.push('</' + n + '>');
        slots.push([]);
      }
    };
    walk(el);
    var parts = draft.split(/(<\/?\d+\/?>)/);
    var runs = parts.filter(function (part, k) { return k % 2 === 0; });
    var tags = parts.filter(function (part, k) { return k % 2 === 1; });
    if (tags.join('') !== boundaries.join('')) return false;
    for (var r = 0; r < runs.length; r += 1) if (runs[r] !== '' && slots[r].length === 0) return false;
    slots.forEach(function (nodes, k) {
      if (nodes.length === 0) return;
      var text = nodes.map(function (node) { return node.data; }).join('');
      var lead = k === 0 ? /^\s*/.exec(text)[0] : '';
      var trail = k === slots.length - 1 ? /\s*$/.exec(text)[0] : '';
      nodes.forEach(function (node, j) {
        swapped.push({ node: node, text: node.data });
        node.data = j === 0 ? lead + runs[k] + trail : '';
      });
    });
    return true;
  }

  function locate(request, scroll) {
    // A key picked anew may open again what another hand closed.
    if (last === null || request.key !== last.key || scroll) declined = [];
    clear(true);
    last = request;
    var texts = request.texts || [];
    var draft = typeof request.draft === 'string' ? request.draft : null;
    var by = 'mark';
    // A derived key is shown where its source renders: the page names the source's mark.
    var hits = byMark(typeof request.mark === 'string' ? request.mark : request.key);
    // A draft mapped piece by piece: one line per hit, else the whole draft.
    var pieces = null;
    var unmapped = false;
    if (hits.length === 0) {
      by = 'text';
      // A template that renders each line of a value in its own element or
      // text node holds no one text with all of it: each non-empty line is
      // then matched on its own, and every piece is outlined.
      var lines = texts.length === 1 && texts[0].indexOf('\n') !== -1
        ? texts[0].split('\n').map(function (line) { return norm(line) === '' ? '' : line; })
        : null;
      var byLines = function (find) {
        var found = find(lines);
        if (found.length === 0) return found;
        var draftLines = draft === null ? null : draft.split('\n');
        // A draft maps line by line only when it has as many lines as the value.
        pieces = draftLines !== null && draftLines.length === lines.length ? draftLines : null;
        unmapped = draft !== null && pieces === null;
        return found;
      };
      hits = byNode(texts);
      if (hits.length === 0 && lines !== null) hits = byLines(byNode);
      if (hits.length === 0) hits = byElement(texts);
      if (hits.length === 0 && lines !== null) hits = byLines(byElement);
      if (hits.length === 0) {
        by = 'contained';
        hits = byContained(texts);
        if (hits.length === 0 && lines !== null) hits = byLines(byContained);
      }
    }
    // A key that declares numbered placeholder tags maps its draft onto the marked element's structure.
    var tagged = typeof request.tags === 'number';
    var mapped = draft !== null && !unmapped;
    // Text found inside more text is always a guess; a whole-text match is one until a save confirms it;
    // the source of a derived key is outlined dashed, since the key itself is not what the page shows.
    var outline = request.dashed === true || by === 'contained' || (by === 'text' && request.guess === true) ? DASHED : SOLID;
    hits.forEach(function (hit) {
      // Two lines in one element outline it once, so its own outline is what comes back.
      if (!marked.some(function (m) { return m.el === hit.el; })) {
        marked.push({ el: hit.el, outline: hit.el.style.outline, offset: hit.el.style.outlineOffset });
        hit.el.style.outline = outline;
        hit.el.style.outlineOffset = '2px';
      }
      var piece = pieces !== null ? pieces[hit.index] : draft;
      if (!mapped) return;
      // A tagged draft maps only onto the element its key is marked on; text found inside more text waits for Save.
      var done = hit.pattern
        ? !tagged && draftContained(hit, piece)
        : tagged
          ? by === 'mark' && hit.attr === null && draftTagged(hit.el, piece)
          : draftInto(hit, piece);
      if (!done) mapped = false;
    });
    // A key inside a closed <details> opens it; one opened for an earlier key closes.
    var needed = [];
    hits.forEach(function (hit) { disclose(hit.el, needed); });
    closeOpened(needed);
    settle();
    // The page's own content, as against <title> and <meta> in the head, and of it what can be seen.
    var inBody = hits.filter(function (hit) { return document.body !== null && document.body.contains(hit.el); });
    var shownOf = function () { return inBody.filter(function (hit) { return !hiddenEl(hit.el); }); };
    var shown = shownOf();
    if (scroll && shown.length > 0) scrollToCentre(shown[0].el);
    var answer = function (hidden) {
      tell({
        stet: 'located',
        key: request.key,
        seq: request.seq,
        found: hits.length,
        by: by,
        draft: draft === null ? null : mapped ? 'shown' : 'after-save',
        hidden: hidden,
        route: location.pathname,
      });
    };
    // Every hit hidden: answer as shown for now, and name it hidden only if it still is once the page settles.
    answer(false);
    if (inBody.length === 0 || shown.length > 0) return;
    whenSettled(inBody.map(function (hit) { return hit.el; }), function (final) {
      var now = shownOf();
      if (now.length > 0) {
        if (scroll) scrollToCentre(now[0].el);
        return true;
      }
      if (final) answer(true);
      return false;
    });
  }

  var ready = function () { tell({ stet: 'ready', route: location.pathname }); };

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.stet === 'locate' && typeof data.key === 'string' && Array.isArray(data.texts)) locate(data, data.scroll === true);
    else if (data.stet === 'clear') { clear(); last = null; declined = []; }
    // The dashboard asks after every load of the frame, so a `ready` sent
    // before the frame's load reached it is sent again after it.
    else if (data.stet === 'hello') ready();
  });

  // A page leaving the frame says so, so the dashboard stops posting before a
  // page it navigated to could receive anything.
  window.addEventListener('pagehide', function () { endSettle(); tell({ stet: 'bye' }); });

  // A dev server that re-renders part of the page in place keeps the outline
  // and the draft on it. This script's own changes are taken off the
  // observer's queue as they are made, so they never re-trigger it.
  var again = null;
  var observer = new MutationObserver(function () {
    if (last === null) return;
    clearTimeout(again);
    again = setTimeout(function () { if (last !== null) locate(last, false); }, 200);
  });
  function settle() { observer.takeRecords(); }
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
