// The preview agent: injected by `stet dev` into every page its preview shows.
// It finds where a content key renders, outlines it in amber and scrolls it
// into view, and shows the operator's drafts in place of the rendered text. It
// matches every declared key's text against the page (the census), and in Edit
// mode turns a click on copy into a pick and a second click into typing in the
// page itself. It talks to the dashboard by postMessage alone, accepts messages
// only from the dashboard window that framed it, carries the run's preview
// channel on every message it sends so the dashboard can tell it from a page
// the frame navigated to, and never sees the run token. No dependencies; it
// runs in any page.
//
// Messages from the dashboard: hello, locate, clear, census, reads (the keys a
// file of the open page reads, so the census matches only those), layer, mode,
// edit, end. Messages to it: ready, located, census, hover, pick, unmanaged,
// deselect (a click on no key's copy), out (the pointer left the frame), rect,
// typed, edited, key, moved, bye.
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
  // A page that hydrates after it loads: the agent announces itself, and so
  // reads no message and writes nothing, only once hydration has run.
  var hold = script.hasAttribute('data-hold');

  // Solid where stet knows the element renders the key (a mark, or a text
  // match a save has confirmed); dashed where a text match is a guess.
  var SOLID = '2px solid hsl(38 92% 50%)';
  var DASHED = '2px dashed hsl(38 92% 50%)';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var marked = [];   // [{ el, outline, offset }]
  var swapped = [];  // [{ node, text, wrote }] or [{ el, attr, text, wrote }]: `text` is what the page held, `wrote` what this script put there
  var layered = [];  // the layer's swaps, in the same shape
  var last = null;   // the last locate request, re-applied after the page re-renders
  var lastLayer = null; // the last layer request, re-applied the same way
  var opened = [];   // the closed <details> this script opened; a visitor's own are never in it
  var declined = []; // ones it opened that another hand closed again, left closed until the key is picked anew

  var norm = function (text) { return String(text).replace(/\s+/g, ' ').trim(); };
  // The whitespace HTML collapses: a space, tab, newline, form feed or carriage return, and no other.
  var ASCII_SPACE = /[ \t\n\f\r]+/g;
  var tell = function (message) {
    message.channel = channel;
    window.parent.postMessage(message, parentOrigin);
  };

  /** A node's text as typed: its text nodes in order, each `<br>` a newline. */
  function textWithBreaks(node) {
    var out = '';
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1 && c.tagName === 'BR') out += '\n';
      else if (c.nodeType === 1) out += textWithBreaks(c);
    }
    return out;
  }

  /** A value's text with its numbered placeholder tags taken out: `<n/>` a space, `<n>` and `</n>` nothing. */
  function plainOf(value) {
    return norm(String(value).replace(/<\d+\/>/g, ' ').replace(/<\/?\d+>/g, ''));
  }

  /**
   * A value as a test over rendered text: `{{name}}` matches any non-empty run,
   * placeholder tags none. The literal pieces are found in order with
   * `indexOf`, leftmost first, so a near miss costs one pass over the text
   * however many variables the value holds.
   */
  function pattern(value) {
    var plain = plainOf(value);
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

  /**
   * Forget the swap on every text node the page has written to since: its text
   * is the page's now (a save the dev server re-rendered in place), so it is
   * never put back, even where the page wrote the very words this script had.
   */
  function adopt(records) {
    records.forEach(function (record) {
      if (record.type !== 'characterData') return;
      var other = function (s) { return s.node !== record.target; };
      swapped = swapped.filter(other);
      layered = layered.filter(other);
    });
  }

  /** Swap `text` into a text node, remembering in `list` what the page held and what this script put there. */
  function swapText(node, text, list) {
    var held = node.data;
    node.data = text;
    list.push({ node: node, text: held, wrote: node.data });
  }

  /** Give each swapped node or attribute in `list` its text back, only while it still holds what this script wrote. */
  function restoreOwn(list) {
    list.forEach(function (s) {
      if (s.node) {
        if (s.node.data === s.wrote) s.node.data = s.text;
      } else if (s.el.getAttribute(s.attr) === s.wrote) {
        s.el.setAttribute(s.attr, s.text);
      }
    });
  }

  /** Put back every outline and swapped text the page has not rewritten since; the <details> this script opened close too, unless `keepOpen` (a new request settles them). */
  function clear(keepOpen) {
    endSettle();
    endQuiet();
    adopt(observer.takeRecords());
    marked.forEach(function (m) { m.el.style.outline = m.outline; m.el.style.outlineOffset = m.offset; });
    restoreOwn(swapped);
    marked = [];
    swapped = [];
    if (!keepOpen) closeOpened([]);
    settle();
  }

  /** Put back what the layer swapped and forget the layer. */
  function clearLayer() {
    adopt(observer.takeRecords());
    restoreOwn(layered);
    layered = [];
    lastLayer = null;
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
   * A save check that finds nothing may have come before the page rendered: a
   * single-page app announces itself first and draws after, and a dev server
   * that reloads the page after a save does the same. The answer waits until
   * the page's mutations have been quiet for QUIET_MS (at most QUIET_MAX in
   * all), then the lookup runs once more. Every mutation but this script's
   * own, which never reach the observer, starts the quiet window over.
   */
  var QUIET_MS = 300;
  var QUIET_MAX = 5000;
  var quiet = null;
  function awaitQuiet(run) {
    endQuiet();
    var deadline = Date.now() + QUIET_MAX;
    var fire = function () { quiet = null; run(); };
    quiet = {
      timer: setTimeout(fire, QUIET_MS),
      again: function () {
        clearTimeout(quiet.timer);
        quiet.timer = setTimeout(fire, Math.max(0, Math.min(QUIET_MS, deadline - Date.now())));
      },
    };
  }
  function endQuiet() {
    if (quiet !== null) clearTimeout(quiet.timer);
    quiet = null;
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

  // The attributes that carry copy no one sees as text.
  var ATTRS = ['alt', 'aria-label', 'title', 'placeholder'];
  var WITH_ATTRS = '[alt],[aria-label],[title],[placeholder]';

  /** Elements whose `alt`, `aria-label`, `title` or `placeholder` is one of `texts`, each hit naming its attribute. */
  function byAttr(texts) {
    var wanted = texts.map(norm);
    if (!document.body) return [];
    var found = [];
    var all = document.body.querySelectorAll(WITH_ATTRS);
    for (var i = 0; i < all.length; i += 1) {
      for (var j = 0; j < ATTRS.length; j += 1) {
        var value = all[i].getAttribute(ATTRS[j]);
        var index = value === null ? -1 : wanted.indexOf(norm(value));
        if (index !== -1 && wanted[index] !== '') found.push({ el: all[i], attr: ATTRS[j], index: index });
      }
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
      var plain = plainOf(text);
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
  function draftContained(hit, draft, list) {
    if (list.some(function (s) { return s.node === hit.node; })) return true;
    swapText(hit.node, hit.node.data.replace(hit.pattern, function () { return draft; }), list);
    return true;
  }

  /** Swap the draft in where it maps onto one text: a matched text node, an element holding text alone, or an attribute. */
  function draftInto(hit, draft, list) {
    if (hit.node) {
      var edges = /^(\s*)[\s\S]*?(\s*)$/.exec(hit.node.data);
      swapText(hit.node, edges[1] + draft + edges[2], list);
      return true;
    }
    if (hit.attr) {
      var held = hit.el.getAttribute(hit.attr);
      hit.el.setAttribute(hit.attr, draft);
      list.push({ el: hit.el, attr: hit.attr, text: held, wrote: hit.el.getAttribute(hit.attr) });
      return true;
    }
    var nodes = hit.el.childNodes;
    for (var i = 0; i < nodes.length; i += 1) if (nodes[i].nodeType !== 3) return false;
    if (nodes.length === 0) return false;
    swapText(nodes[0], draft, list);
    for (var k = 1; k < nodes.length; k += 1) swapText(nodes[k], '', list);
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
  function draftTagged(el, draft, list) {
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
        swapText(node, j === 0 ? lead + runs[k] + trail : '', list);
      });
    });
    return true;
  }

  /**
   * Where a key renders: its marks, else a whole text node, else an element's
   * whole text, else an attribute, else a text inside more text. `pieces` is
   * the draft mapped line by line where the value renders one line per hit.
   */
  function find(key, texts, draft) {
    var found = { hits: byMark(key), by: 'mark', pieces: null, unmapped: false };
    if (found.hits.length > 0) return found;
    found.by = 'text';
    // A template that renders each line of a value in its own element or
    // text node holds no one text with all of it: each non-empty line is
    // then matched on its own, and every piece is outlined.
    var lines = texts.length === 1 && texts[0].indexOf('\n') !== -1
      ? texts[0].split('\n').map(function (line) { return norm(line) === '' ? '' : line; })
      : null;
    var byLines = function (search) {
      var hits = search(lines);
      if (hits.length === 0) return hits;
      var draftLines = draft === null ? null : draft.split('\n');
      // A draft maps line by line only when it has as many lines as the value.
      found.pieces = draftLines !== null && draftLines.length === lines.length ? draftLines : null;
      found.unmapped = draft !== null && found.pieces === null;
      return hits;
    };
    var hits = byNode(texts);
    if (hits.length === 0 && lines !== null) hits = byLines(byNode);
    if (hits.length === 0) hits = byElement(texts);
    if (hits.length === 0 && lines !== null) hits = byLines(byElement);
    if (hits.length === 0) hits = byAttr(texts);
    if (hits.length === 0) {
      found.by = 'contained';
      hits = byContained(texts);
      if (hits.length === 0 && lines !== null) hits = byLines(byContained);
    }
    found.hits = hits;
    return found;
  }

  /** Condition 2: whether `el` is the element under edit, holds it or sits inside it — outlined, never swapped. */
  function touchesEdit(el) {
    return edit !== null && (el === edit.el || el.contains(edit.el) || edit.el.contains(el));
  }

  function locate(request, scroll, retried, silent) {
    // A key picked anew may open again what another hand closed.
    if (last === null || request.key !== last.key || scroll) declined = [];
    clear(true);
    // The layer's writes go back too, so the search reads the page's own text; the layer returns after.
    restoreOwn(layered);
    layered = [];
    last = request;
    var texts = request.texts || [];
    var draft = typeof request.draft === 'string' ? request.draft : null;
    // A derived key is shown where its source renders: the page names the source's mark.
    var found = find(typeof request.mark === 'string' ? request.mark : request.key, texts, draft);
    var hits = found.hits;
    var by = found.by;
    // A draft mapped piece by piece: one line per hit, else the whole draft.
    var pieces = found.pieces;
    // A key that declares numbered placeholder tags maps its draft onto the marked element's structure.
    var tagged = typeof request.tags === 'number';
    var mapped = draft !== null && !found.unmapped;
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
      if (!mapped || touchesEdit(hit.el)) return;
      // A tagged draft maps only onto the element its key is marked on; text found inside more text waits for Save.
      var done = hit.pattern
        ? !tagged && draftContained(hit, piece, swapped)
        : tagged
          ? by === 'mark' && hit.attr === null && draftTagged(hit.el, piece, swapped)
          : draftInto(hit, piece, swapped);
      if (!done) mapped = false;
    });
    settle();
    if (lastLayer !== null) layer(lastLayer);
    // A save check that found nothing waits for the page to settle and looks once more.
    if (hits.length === 0 && request.check === true && retried !== true) {
      awaitQuiet(function () { locate(request, scroll, true, silent); });
      return;
    }
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
      if (silent === true) return;
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

  /** Whether a swap in `list` stands on the hit's node or attribute. */
  function held(hit, list) {
    return list.some(function (s) { return hit.node ? s.node === hit.node : !s.node && s.el === hit.el && s.attr === hit.attr; });
  }

  /**
   * Every shown draft but the selected key's, swapped in at once: found as
   * `locate` finds a key, never into the element under edit or a node the
   * selected key's swap holds, and recorded in `layered`. `locate` puts the
   * layer back before it searches and applies it again after its own swap.
   */
  function layer(drafts) {
    adopt(observer.takeRecords());
    restoreOwn(layered);
    layered = [];
    lastLayer = drafts;
    drafts.forEach(function (d) {
      var found = find(d.key, d.texts, d.draft);
      if (found.unmapped) return;
      var tagged = typeof d.tags === 'number';
      found.hits.forEach(function (hit) {
        if (touchesEdit(hit.el) || held(hit, swapped)) return;
        var piece = found.pieces !== null ? found.pieces[hit.index] : d.draft;
        if (hit.pattern) { if (!tagged) draftContained(hit, piece, layered); }
        else if (tagged) { if (found.by === 'mark' && hit.attr === null) draftTagged(hit.el, piece, layered); }
        else draftInto(hit, piece, layered);
      });
    });
    settle();
  }

  // ---- The census: every declared key's texts matched against the page ----

  var RUN = /[\p{L}\p{N}]+/gu;
  function isLN(ch) { return ch !== undefined && /[\p{L}\p{N}]/u.test(ch); }
  // A text this short, or with no letter or digit, claims any lone `·` or `.` the page writes.
  function weakText(text) { return text.length < 3 || !/[\p{L}\p{N}]/u.test(text); }
  // The elements a static-HTML host's marks sit on: the text mark and each attribute a mark may name.
  var MARKED = '[data-stet],[data-stet-alt],[data-stet-aria-label],[data-stet-title],[data-stet-placeholder],[data-stet-content]';
  var HEAD_METAS = [
    ['description', 'meta[name="description"]'],
    ['og:title', 'meta[property="og:title"],meta[name="og:title"]'],
    ['og:description', 'meta[property="og:description"],meta[name="og:description"]'],
    ['twitter:title', 'meta[name="twitter:title"],meta[property="twitter:title"]'],
    ['twitter:description', 'meta[name="twitter:description"],meta[property="twitter:description"]'],
  ];
  var payload = null; // the last census payload's keys (`censusKeys`)
  var reads = null;   // the open route's reads from the dashboard: { route, keys: Set }, or null where it cannot tell
  var index = null;   // the matchers over `payload`, rebuilt when the payload or the reads that apply change (`buildIndex`)
  var hits = new Map(); // element → [{ key, attr, by, node?, entry?, weak? }], what hover and click read

  /** The first run of letters and digits in `text`, or null. */
  function firstRun(text) {
    RUN.lastIndex = 0;
    return RUN.exec(text);
  }

  /**
   * One payload's matchers: `whole`, each plain text to the keys and entries
   * that hold it; `patterns`, the `{{name}}` texts, by the first word of the
   * text before their first variable (`loose` where that word could run on
   * into the variable); `contained`, a first-word index over every plain text
   * of CONTAINED_MIN or more characters, each list longest text first. A value
   * that is all variables matches nothing.
   */
  function censusIndex(keys, allowed) {
    var whole = new Map();
    var patterns = new Map();
    var loose = [];
    var declared = new Set();
    var lines = new Map(); // a line of a value written over several lines → true, so the walk notes where it stands
    var multi = [];        // [{ key, entry, lines }]: each such value, its non-empty lines normalized
    keys.forEach(function (k) {
      // Every key stays declared, so a mark always names it; only the keys the page reads are matched by text.
      declared.add(k.key);
      if (allowed !== null && !allowed.has(k.key)) return;
      var add = function (texts, entry) {
        texts.forEach(function (text) {
          var plain = plainOf(text);
          if (plain === '') return;
          var split = String(text).split('\n').map(plainOf).filter(function (line) { return line !== ''; });
          if (split.length > 1 && !split.some(function (line) { return /\{\{/.test(line); })) {
            multi.push({ key: k.key, entry: entry, lines: split });
            split.forEach(function (line) { lines.set(line, true); });
          }
          if (/\{\{/.test(plain)) {
            var literal = norm(plain.replace(/\{\{\s*[\w.]+\s*\}\}/g, ' '));
            if (literal === '') return;
            var p = { key: k.key, entry: entry, test: pattern(text).test, weak: weakText(literal) };
            var prefix = plain.split(/\{\{\s*[\w.]+\s*\}\}/)[0];
            var run = firstRun(prefix);
            if (run === null || run.index + run[0].length === prefix.length) loose.push(p);
            else {
              var bucket = patterns.get(run[0]);
              if (bucket === undefined) patterns.set(run[0], (bucket = []));
              bucket.push(p);
            }
            return;
          }
          var list = whole.get(plain);
          if (list === undefined) whole.set(plain, (list = []));
          if (!list.some(function (h) { return h.key === k.key && h.entry === entry; })) list.push({ key: k.key, entry: entry });
        });
      };
      add(k.texts, undefined);
      k.parts.forEach(function (part) { add(part.texts, part.entry); });
    });
    var plains = [];
    whole.forEach(function (list, text) { if (text.length >= CONTAINED_MIN) plains.push(text); });

    var contained = new Map();
    plains.forEach(function (text) {
      RUN.lastIndex = 0;
      var first = RUN.exec(text);
      if (first === null) return; // no letter or digit: never a contained match
      var list = contained.get(first[0]);
      if (list === undefined) contained.set(first[0], (list = []));
      list.push({ text: text, at: first.index });
    });
    contained.forEach(function (list) { list.sort(function (a, b) { return b.text.length - a.text.length; }); });

    // The contained texts in one text node: leftmost first, the longest at a position
    // first, never overlapping, each bounded by a non-letter-or-digit on both sides.
    function containedIn(data) {
      var s = norm(data), found = [], from = 0, run;
      RUN.lastIndex = 0;
      while ((run = RUN.exec(s)) !== null) {
        var list = contained.get(run[0]);
        if (list === undefined) continue;
        for (var i = 0; i < list.length; i++) {
          var start = run.index - list[i].at, end = start + list[i].text.length;
          if (start < from || !s.startsWith(list[i].text, start)) continue;
          if (isLN(s[start - 1]) || isLN(s[end])) continue;
          found.push(list[i].text);
          from = end;
          RUN.lastIndex = end;
          break;
        }
      }
      return found;
    }

    // The patterns a text can match: those whose first word is the text's, and the loose ones.
    function patternsFor(text) {
      var run = firstRun(text);
      var bucket = run === null ? undefined : patterns.get(run[0]);
      return bucket === undefined ? loose : loose.concat(bucket);
    }

    return { whole: whole, patternsFor: patternsFor, containedIn: containedIn, declared: declared, lines: lines, multi: multi };
  }

  /** The reads that apply to the page the frame shows: the dashboard's, for this path; else none. */
  function readsHere() {
    return reads !== null && reads.route === location.pathname ? reads.keys : null;
  }
  function buildIndex() {
    index = payload === null ? null : censusIndex(payload, readsHere());
  }

  /** The page's own text and attribute values where this script's swap still stands in them. */
  function pageValues() {
    var nodes = new Map();
    var attrs = new Map();
    swapped.concat(layered).forEach(function (s) {
      if (s.node) { if (s.node.data === s.wrote) nodes.set(s.node, s.text); }
      else if (s.el.getAttribute(s.attr) === s.wrote) attrs.set(s.el, (attrs.get(s.el) || []).concat([[s.attr, s.text]]));
    });
    return {
      text: function (node) { return nodes.has(node) ? nodes.get(node) : node.data; },
      attr: function (el, name) {
        var own = attrs.get(el);
        for (var i = 0; own && i < own.length; i += 1) if (own[i][0] === name) return own[i][1];
        return el.getAttribute(name);
      },
    };
  }

  /**
   * One walk over the page with the payload's matchers: each text node by its
   * whole text, else a pattern, else every contained text; then the elements
   * whose whole text matches with no text-node hit inside; then the four
   * attributes; then the title and the head's description metas. On a page
   * that carries marks (the static-HTML host) the marks decide, and the census
   * adds only an attribute no mark names. A swapped node is read as the page
   * holds it, so a shown draft still answers for its key.
   */
  function census() {
    var whole = index.whole;
    hits = new Map();
    var places = Object.create(null);  // key → Set of elements
    var strong = Object.create(null);  // key → found by more than a short fragment
    var entries = Object.create(null);
    var shown = new Set();             // the whole texts the page shows
    var head = [];
    var page = pageValues();
    var lineAt = new Map(); // a line → [{ el, node? }], the deepest places whose whole text is that line
    var lineCount = Object.create(null); // key → how many times every line of its value stands on the page
    var noteLine = function (text, el, node) {
      if (!index.lines.has(text)) return;
      var at = lineAt.get(text);
      if (at === undefined) lineAt.set(text, (at = []));
      if (at.some(function (c) { return el.contains(c.el); })) return;
      at.push(node === undefined ? { el: el } : { el: el, node: node });
    };
    var record = function (el, hit) {
      var list = hits.get(el);
      if (list === undefined) hits.set(el, (list = []));
      list.push(hit);
      (places[hit.key] || (places[hit.key] = new Set())).add(el);
      if (!hit.weak) strong[hit.key] = true;
      if (hit.entry !== undefined) {
        var at = entries[hit.key] || (entries[hit.key] = []);
        if (at.indexOf(hit.entry) === -1) at.push(hit.entry);
      }
    };
    var wholeHits = function (el, text, extra) {
      var list = whole.get(text);
      if (list === undefined) return false;
      shown.add(text);
      list.forEach(function (h) {
        var hit = { key: h.key, attr: null, by: 'whole', weak: weakText(text) };
        if (h.entry !== undefined) hit.entry = h.entry;
        for (var name in extra) hit[name] = extra[name];
        record(el, hit);
      });
      return true;
    };
    var marks = document.querySelectorAll(MARKED);
    var body = document.body;
    if (marks.length > 0) {
      for (var m = 0; m < marks.length; m += 1) {
        var attributes = marks[m].attributes;
        for (var a = 0; a < attributes.length; a += 1) {
          var name = attributes[a].name;
          if (name.indexOf('data-stet') !== 0 || !index.declared.has(attributes[a].value)) continue;
          if (name === 'data-stet') record(marks[m], { key: attributes[a].value, attr: null, by: 'mark' });
          else if (name.indexOf('data-stet-') === 0) record(marks[m], { key: attributes[a].value, attr: name.slice('data-stet-'.length), by: 'mark' });
        }
      }
    } else if (body) {
      var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        var parent = node.parentElement;
        if (!parent || SKIP[parent.tagName]) continue;
        var data = page.text(node);
        var t = norm(data);
        if (t === '') continue;
        noteLine(t, parent, node);
        if (wholeHits(parent, t, { node: node })) continue;
        var matched = false;
        var candidates = index.patternsFor(t);
        for (var p = 0; p < candidates.length; p += 1) {
          var pat = candidates[p];
          if (!pat.test(t)) continue;
          matched = true;
          var hit = { key: pat.key, attr: null, by: 'pattern', node: node, weak: pat.weak };
          if (pat.entry !== undefined) hit.entry = pat.entry;
          record(parent, hit);
        }
        if (matched) continue;
        index.containedIn(data).forEach(function (text) {
          whole.get(text).forEach(function (h) {
            var hit = { key: h.key, attr: null, by: 'contained', node: node };
            if (h.entry !== undefined) hit.entry = h.entry;
            record(parent, hit);
          });
        });
      }
      // Text split across inline elements: an element whose whole text is a key's, deepest first;
      // each <br> inside reads as the line break it renders, so a value's lines meet it as they stand.
      var withBreaks = new Set();
      body.querySelectorAll('br').forEach(function (br) {
        for (var up = br.parentElement; up && !withBreaks.has(up); up = up.parentElement) withBreaks.add(up);
      });
      var all = body.querySelectorAll('*');
      for (var i = all.length - 1; i >= 0; i -= 1) {
        var el = all[i];
        if (SKIP[el.tagName] || el.firstElementChild === null) continue;
        var text = norm(withBreaks.has(el) ? textWithBreaks(el) : el.textContent);
        noteLine(text, el);
        var list = whole.get(text);
        if (list === undefined) continue;
        list.forEach(function (h) {
          var at = places[h.key];
          if (at !== undefined && Array.from(at).some(function (e) { return el.contains(e); })) return;
          shown.add(text);
          var hit = { key: h.key, attr: null, by: 'element', weak: weakText(text) };
          if (h.entry !== undefined) hit.entry = h.entry;
          record(el, hit);
        });
      }
      // A value written over several lines, each in its own element: found line by line where no
      // whole text, pattern or contained match found the key, and only where every line stands.
      // The keys those stages found are taken first, so a key's later entries are matched like its first.
      var foundBefore = new Set(Object.keys(places));
      index.multi.forEach(function (m) {
        if (foundBefore.has(m.key)) return;
        var at = m.lines.map(function (line) { return lineAt.get(line) || []; });
        if (at.some(function (list) { return list.length === 0; })) return;
        at.forEach(function (list, i) {
          list.forEach(function (c) {
            var hit = { key: m.key, attr: null, by: 'line', line: i, weak: weakText(m.lines[i]) };
            if (c.node !== undefined) hit.node = c.node;
            if (m.entry !== undefined) hit.entry = m.entry;
            record(c.el, hit);
          });
        });
        lineCount[m.key] = (lineCount[m.key] || 0) + Math.min.apply(null, at.map(function (list) { return list.length; }));
      });
      var title = document.querySelector('title');
      if (title !== null && wholeHits(title, norm(document.title), {})) whole.get(norm(document.title)).forEach(function (h) { head.push({ key: h.key, where: 'title' }); });
      HEAD_METAS.forEach(function (meta) {
        var at = document.head && document.head.querySelector(meta[1]);
        var content = at ? norm(at.getAttribute('content') || '') : '';
        if (content !== '' && wholeHits(at, content, { attr: 'content' })) whole.get(content).forEach(function (h) { head.push({ key: h.key, where: meta[0] }); });
      });
    }
    if (body) {
      var withAttrs = body.querySelectorAll(WITH_ATTRS);
      for (var w = 0; w < withAttrs.length; w += 1) {
        for (var n = 0; n < ATTRS.length; n += 1) {
          var value = page.attr(withAttrs[w], ATTRS[n]);
          if (value === null || (marks.length > 0 && withAttrs[w].hasAttribute('data-stet-' + ATTRS[n]))) continue;
          wholeHits(withAttrs[w], norm(value), { attr: ATTRS[n], by: 'attr' });
        }
      }
    }
    var found = Object.create(null);
    var weak = [];
    for (var key in places) {
      found[key] = lineCount[key] !== undefined ? lineCount[key] : places[key].size;
      if (strong[key] !== true) weak.push(key);
    }
    var ambiguous = [];
    shown.forEach(function (text) {
      var keys = [];
      whole.get(text).forEach(function (h) { if (keys.indexOf(h.key) === -1) keys.push(h.key); });
      if (keys.length > 1) ambiguous.push(keys);
    });
    return { stet: 'census', found: found, entries: entries, ambiguous: ambiguous, weak: weak, head: head, route: location.pathname };
  }

  /** The census, answered, unless no payload has come or an edit is open (the edit's own keystrokes change the text). */
  function runCensus() {
    if (index !== null && edit === null) tell(census());
  }

  // ---- Edit mode: hover, pick, and the keys pressed in the frame ----

  var mode = 'use';
  var HOVER_RING = '0 0 0 1px hsl(38 92% 50% / .9)';
  var SELECT_RING = '0 0 0 2px hsl(38 92% 50%)';
  var hoverEl = null;
  var hoverWas = '';
  var selEl = null;
  var selWas = '';
  // The element a pick `again` went to in this press, so the dblclick after a second click sends no second one.
  var againEl = null;
  var PRESSES = ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'];
  var BLOCKED = ['click', 'auxclick', 'submit', 'dblclick'];

  /** The nearest element at or above `target` the census has hits on, with them. */
  function hitsAt(target) {
    for (var el = target && target.nodeType === 1 ? target : target && target.parentElement; el; el = el.parentElement) {
      var list = hits.get(el);
      if (list !== undefined && list.length > 0) return { el: el, hits: list };
    }
    return null;
  }

  /** Whether a hit can be typed in place: the text of a visible HTML element whose only words are the key's, or a marked element. */
  function inplaceHit(el, hit) {
    if (hit.attr !== null || !(el instanceof HTMLElement) || el.closest('svg') || !document.body.contains(el)) return false;
    if (hit.by === 'mark') return true;
    return hit.by === 'whole' && inplaceable(el, hit.node);
  }

  /** The hits on an element as a message lists them, one per key, attribute and entry. */
  function keysOf(at, full) {
    var seen = [];
    var keys = [];
    at.hits.forEach(function (hit) {
      var id = hit.key + ' ' + hit.attr + ' ' + hit.entry;
      if (seen.indexOf(id) !== -1) return;
      seen.push(id);
      var key = { key: hit.key, attr: hit.attr, by: hit.by };
      if (full) {
        if (hit.entry !== undefined) key.entry = hit.entry;
        key.inplace = inplaceHit(at.el, hit);
      }
      keys.push(key);
    });
    return keys;
  }

  function rectOf(el) {
    var box = el.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  /** The 1 px ring on the copy under the pointer; the element's own box-shadow comes back when it leaves. */
  function setHover(el) {
    if (el === hoverEl) return;
    if (hoverEl !== null && hoverEl !== selEl) hoverEl.style.boxShadow = hoverWas;
    hoverEl = el;
    if (el !== null && el !== selEl) {
      hoverWas = el.style.boxShadow;
      el.style.boxShadow = HOVER_RING;
    }
  }

  /** The 2 px ring on the selected copy, or none. */
  function select(el) {
    if (el === selEl) return;
    if (selEl !== null) selEl.style.boxShadow = selEl === hoverEl ? HOVER_RING : selWas;
    selEl = el;
    if (el !== null) {
      selWas = el === hoverEl ? hoverWas : el.style.boxShadow;
      el.style.boxShadow = SELECT_RING;
    }
  }

  /** Whether the editor can see `el`: it has a box, it is visible, and neither it nor any ancestor is fully transparent. */
  function seen(el) {
    if (el.getClientRects().length === 0 || getComputedStyle(el).visibility !== 'visible') return false;
    for (var up = el; up !== null; up = up.parentElement) if (getComputedStyle(up).opacity === '0') return false;
    return true;
  }

  /**
   * What the pointer is on, as the editor sees it: the topmost element at the
   * event's point that `seen` allows, so a transparent or hidden element stacked
   * over visible copy never takes the hover or the click. A key-made click
   * (`detail` 0) and a browser that cannot list the stack keep the event's target;
   * a point where nothing is seen names nothing.
   */
  function visibleAt(event) {
    if ((event.type === 'click' && event.detail === 0) || typeof document.elementsFromPoint !== 'function') return event.target;
    var stack = document.elementsFromPoint(event.clientX, event.clientY);
    if (stack.length === 0) return event.target;
    for (var i = 0; i < stack.length; i += 1) if (seen(stack[i])) return stack[i];
    return null;
  }

  function insideEdit(target) {
    return edit !== null && target instanceof Node && edit.el.contains(target);
  }

  // A press reaches the page's handlers no more, and keeps its default: focus and selection move as they would.
  function onPress(event) {
    if (insideEdit(event.target)) return;
    if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'touchstart') againEl = null;
    event.stopImmediatePropagation();
  }

  // A click, a submit or a double click does nothing in the page; a click on copy picks it.
  // Inside the element under edit it does nothing either: the press already moved the caret.
  var clickAt = null; // where the last click landed, so the runs form can start on the island under it
  function onBlocked(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (insideEdit(event.target)) return;
    if (event.type === 'click' || event.type === 'dblclick') clickAt = { x: event.clientX, y: event.clientY };
    if (event.type === 'click') pickAt(visibleAt(event), false);
    else if (event.type === 'dblclick') pickAt(visibleAt(event), true);
  }

  function onOver(event) {
    if (insideEdit(event.target)) return;
    var at = hitsAt(visibleAt(event));
    var el = at === null ? null : at.el;
    if (el === hoverEl) return;
    setHover(el);
    if (at === null) { tell({ stet: 'hover', keys: [] }); return; }
    tell({
      stet: 'hover',
      keys: keysOf(at, false),
      tag: el.tagName.toLowerCase(),
      rect: rectOf(el),
      inplace: at.hits.some(function (hit) { return inplaceHit(el, hit); }),
    });
  }

  // The pointer leaving the frame — a mouse or a pen; a touch pointer leaves at every lift — takes the hover ring off and says so.
  function onOut(event) {
    if (event.relatedTarget !== null || event.pointerType === 'touch') return;
    setHover(null);
    tell({ stet: 'out' });
  }

  /**
   * A click on copy selects it: `pick` with each hit, `again` for a second
   * click on the selected element or a double click, `key` for a pick made
   * by Enter, and `sel` (the text a double click selected and where it
   * starts in the element's text) when one did. A click on no key's copy
   * takes the ring off and sends `deselect`; when the element under the
   * click has text of its own it also sends `unmanaged`. A click outside the
   * element under edit ends the edit, kept, before anything is sent.
   */
  function pickAt(target, again, byKey) {
    end('keep');
    var at = hitsAt(target);
    if (at === null) {
      select(null);
      tell({ stet: 'deselect' });
      if (target && target.nodeType === 1 && hasOwnText(target)) {
        var text = norm(target.textContent || '').slice(0, 120);
        if (text !== '') tell({ stet: 'unmanaged', text: text, tag: target.tagName.toLowerCase() });
      }
      return;
    }
    if (again && againEl === at.el) return;
    if (at.el === selEl) again = true;
    select(at.el);
    if (again) againEl = at.el;
    var pick = { stet: 'pick', keys: keysOf(at, true), tag: at.el.tagName.toLowerCase(), rect: rectOf(at.el), again: again };
    if (byKey) pick.key = true;
    else if (again) {
      var sel = selectedIn(at.el);
      if (sel !== null) pick.sel = sel;
    }
    tell(pick);
  }

  /** Whether `el` has a text node of its own with a letter or digit, so a click on it is on copy and not on the space around it. */
  function hasOwnText(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /[\p{L}\p{N}]/u.test(c.data)) return true;
    return false;
  }

  /** The page's selection when it is not collapsed and lies inside `el`: its text, and where it starts in the element's text. Null otherwise. */
  function selectedIn(el) {
    var selection = getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    var before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    return { text: range.toString(), offset: before.toString().length };
  }

  /** Whether keys pressed at `target` are typing: an input, a textarea, a select or editable content. */
  function typing(target) {
    if (!target || target.nodeType !== 1) return false;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    var editable = target.closest('[contenteditable]');
    return editable !== null && editable.getAttribute('contenteditable') !== 'false';
  }

  // Keys pressed in the frame, in every mode: Cmd/Ctrl-S moves focus to the
  // dashboard's Save and writes nothing; in Edit, Escape ends the selection and
  // Enter starts the edit on it; E switches between Edit and Use.
  function onKey(event) {
    var mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      end('keep');
      tell({ stet: 'key', which: 'save' });
      return;
    }
    if (edit !== null || mod || event.altKey) return;
    if (mode === 'edit' && event.key === 'Escape') { tell({ stet: 'key', which: 'escape' }); return; }
    if (typing(event.target)) return;
    if (event.key === 'e' || event.key === 'E') { tell({ stet: 'key', which: 'mode' }); return; }
    if (mode === 'edit' && event.key === 'Enter' && selEl !== null && hits.has(selEl)) {
      event.preventDefault();
      againEl = null;
      clickAt = null;
      pickAt(selEl, true, true);
    }
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    var method = mode === 'edit' ? 'addEventListener' : 'removeEventListener';
    PRESSES.forEach(function (type) { window[method](type, onPress, true); });
    BLOCKED.forEach(function (type) { window[method](type, onBlocked, true); });
    window[method]('pointerover', onOver, true);
    window[method]('pointerout', onOut, true);
    if (mode === 'use') {
      end('keep');
      setHover(null);
    }
  }

  // The selected element's box after the frame scrolls or resizes, at most once a frame.
  var rectPending = false;
  function onViewport() {
    if (rectPending || (selEl === null && edit === null)) return;
    rectPending = true;
    requestAnimationFrame(function () {
      rectPending = false;
      var el = edit !== null ? edit.el : selEl;
      if (el !== null) tell({ stet: 'rect', rect: rectOf(el) });
    });
  }

  // ---- The in-place edit (conditions 1–4) ----

  var edit = null;

  function inplaceable(el, node) {
    if (!(el instanceof HTMLElement) || el.closest('svg')) return false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c === node) continue;
      if (c.nodeType === 3 && norm(c.data) !== '') return false;
      if (c.nodeType === 1 && norm(c.textContent) !== '') return false;
    }
    return true;
  }

  function typedValue(el, oneLine) {
    var out = textWithBreaks(el);
    if (out.slice(-1) === '\n') out = out.slice(0, -1);
    return oneLine ? norm(out.replace(/\n/g, ' ')) : out.trim();
  }

  /**
   * The runs form's value: each island's text, with the marked element's own
   * descendants numbered depth-first as `draftTagged` numbers them (islands
   * are not counted) and written as `<n>`, `</n>` and `<n/>` at their
   * boundaries. The first run's leading and the last run's trailing whitespace
   * are the element's, not the value's, and a run of whitespace is one space,
   * as HTML renders it, so the page source's line wrapping never reaches the value.
   */
  function taggedValue(el) {
    var number = new Map();
    var all = el.querySelectorAll('*');
    for (var i = 0, n = 0; i < all.length; i += 1) {
      if (all[i].closest('[data-stet-island]') === null) number.set(all[i], (n += 1));
    }
    var out = '';
    var walk = function (node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeType !== 1) continue;
        else if (c.hasAttribute('data-stet-island')) out += textWithBreaks(c);
        else if (c.firstElementChild === null && norm(c.textContent) === '') out += '<' + number.get(c) + '/>';
        else {
          out += '<' + number.get(c) + '>';
          walk(c);
          out += '</' + number.get(c) + '>';
        }
      }
    };
    walk(el);
    return out.replace(ASCII_SPACE, ' ').trim();
  }

  function editListeners(el, method) {
    el[method]('beforeinput', onBeforeInput);
    el[method]('input', onInput);
    el[method]('compositionstart', onCompositionStart);
    el[method]('compositionend', onCompositionEnd);
    el[method]('keydown', onEditKey);
    el[method]('focusout', onEditFocusOut);
  }

  /**
   * A collapsed caret in `el`: where the last click landed when that point is
   * inside it, else after its last character. Nothing is selected, so typing
   * inserts.
   */
  function caretAt(el) {
    var range = null;
    if (clickAt !== null && typeof document.caretPositionFromPoint === 'function') {
      var at = document.caretPositionFromPoint(clickAt.x, clickAt.y);
      if (at !== null && el.contains(at.offsetNode)) { range = document.createRange(); range.setStart(at.offsetNode, at.offset); }
    } else if (clickAt !== null && typeof document.caretRangeFromPoint === 'function') {
      var hit = document.caretRangeFromPoint(clickAt.x, clickAt.y);
      if (hit !== null && el.contains(hit.startContainer)) range = hit;
    }
    if (range === null) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.collapse(true);
    var selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function startInplace(el, node, key, locale, entry, oneLine) {
    var nodes = Array.prototype.slice.call(el.childNodes);
    edit = {
      key: key, locale: locale, entry: entry, oneLine: oneLine, el: el,
      nodes: nodes,
      data: nodes.map(function (n) { return n.nodeType === 3 ? n.data : null; }),
      last: null, attached: null,
      ownText: el.textContent, pending: false, pendingTimer: null, composing: false, proposed: false,
      observer: new MutationObserver(onEditMutation),
    };
    edit.last = edit.data.slice();
    edit.attached = nodes.map(function () { return true; });
    edit.observer.observe(el, { childList: true, characterData: true, subtree: true });
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('spellcheck', 'false');
    editListeners(el, 'addEventListener');
    // A double click's word stays selected, so typing replaces it; any other start puts a caret where the click landed.
    var word = selectedIn(el) === null ? null : getSelection().getRangeAt(0).cloneRange();
    window.focus();
    el.focus();
    if (word === null) { caretAt(el); return; }
    getSelection().removeAllRanges();
    getSelection().addRange(word);
  }

  /** The island the last click landed on, where the browser can say where text sits; undefined for a key press or a click on no run. */
  function islandAtClick(islands) {
    if (clickAt === null) return undefined;
    return islands.filter(function (island) {
      var range = document.createRange();
      range.selectNodeContents(island);
      if (typeof range.getClientRects !== 'function') return false;
      return Array.prototype.some.call(range.getClientRects(), function (r) {
        return clickAt.x >= r.left && clickAt.x <= r.right && clickAt.y >= r.top && clickAt.y <= r.bottom;
      });
    })[0];
  }

  /**
   * The runs form (static-HTML host): each text node of the marked element is
   * moved into its own editable island, so the element's markup between the
   * runs stays the page's. The island under the click starts selected, else the
   * first island with text.
   */
  function startRuns(el, key, locale, entry, oneLine) {
    var word = wordIn(el);
    var nodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    var islands = nodes.map(function (n) {
      var island = document.createElement('span');
      island.setAttribute('contenteditable', 'plaintext-only');
      island.setAttribute('spellcheck', 'false');
      island.setAttribute('data-stet-island', '');
      n.parentNode.insertBefore(island, n);
      island.appendChild(n);
      return island;
    });
    settle();
    edit = {
      key: key, locale: locale, entry: entry, oneLine: oneLine, el: el,
      nodes: nodes, islands: islands,
      data: nodes.map(function (n) { return n.data; }),
      last: null, attached: null,
      ownText: el.textContent, pending: false, pendingTimer: null, composing: false, proposed: false,
      observer: new MutationObserver(onEditMutation),
    };
    edit.last = edit.data.slice();
    edit.attached = nodes.map(function () { return false; });
    edit.observer.observe(el, { childList: true, characterData: true, subtree: true });
    editListeners(el, 'addEventListener');
    window.focus();
    // A double click's word stays selected in its island, so typing replaces it; the wrapping moved its text node, so the range is made again.
    var first = (word !== null && islands[nodes.indexOf(word.node)]) || islandAtClick(islands) ||
      islands.filter(function (island) { return norm(island.textContent) !== ''; })[0] || islands[0];
    if (first === undefined) return;
    first.focus();
    if (word === null || nodes.indexOf(word.node) === -1) { caretAt(first); return; }
    var range = document.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  /** The page's non-collapsed selection when it lies inside one text node of `el`: that node and the offsets. Null otherwise. */
  function wordIn(el) {
    var selection = getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    var node = range.startContainer;
    if (node !== range.endContainer || node.nodeType !== 3 || !el.contains(node)) return null;
    return { node: node, start: range.startOffset, end: range.endOffset };
  }

  // Condition 3. The browser edits the DOM, runs the microtask checkpoint (the
  // observer), then dispatches `input`: the edit's own keystroke is marked at
  // `beforeinput`, which precedes the mutation.
  function onBeforeInput() {
    if (edit === null) return;
    edit.pending = true;
    // `input` is dispatched in the same task as the edit's own mutation; a
    // beforeinput the browser then finds nothing to do for (Backspace at the
    // start, Delete at the end) sends no input, so the mark is cleared after the
    // task and the comparison it held back runs.
    clearTimeout(edit.pendingTimer);
    edit.pendingTimer = setTimeout(function () {
      if (edit === null || !edit.pending) return;
      edit.pending = false;
      onEditMutation();
    }, 0);
  }
  function onInput() {
    if (edit === null) return;
    clearTimeout(edit.pendingTimer);
    edit.pending = false;
    edit.ownText = edit.el.textContent;
    edit.last = edit.nodes.map(function (n) { return n.nodeType === 3 ? n.data : null; });
    edit.attached = edit.nodes.map(function (n) { return n.parentNode === edit.el; });
    if (!edit.composing) propose();
  }
  function onCompositionStart() { if (edit !== null) edit.composing = true; }
  function onCompositionEnd() { if (edit === null) return; edit.composing = false; propose(); }
  function propose() {
    edit.proposed = true;
    var value = edit.islands ? taggedValue(edit.el) : typedValue(edit.el, edit.oneLine);
    tell({ stet: 'typed', key: edit.key, locale: edit.locale, entry: edit.entry, value: value });
  }
  function onEditMutation() {
    if (edit === null || edit.pending) return;
    if (edit.el.textContent !== edit.ownText) end('lost');
  }
  function watchConnected() {
    if (edit !== null && !edit.el.isConnected) end('lost');
  }

  // Focus leaving the element ends the edit, kept: a click on other copy, on the
  // dashboard (Save included) or anywhere else. Moving between the runs form's
  // islands stays inside the element.
  function onEditFocusOut(event) {
    if (edit === null) return;
    if (event.relatedTarget instanceof Node && edit.el.contains(event.relatedTarget)) return;
    // A removal fires focusout while the element is still in the document: look again once the page's own code is done.
    var open = edit;
    Promise.resolve().then(function () { if (edit === open) end(open.el.isConnected ? 'keep' : 'lost'); });
  }

  function onEditKey(event) {
    // A key pressed during composition is the input method's.
    if (edit === null || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); end('keep'); return; }
    if (event.key === 'Enter' && event.shiftKey && edit.oneLine) { event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); end('cancel'); return; }
    // A space on a button or a summary is its activation: the agent types it, so the element never sees it.
    if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); document.execCommand('insertText', false, ' '); return; }
    if ((event.metaKey || event.ctrlKey) && /^[biu]$/i.test(event.key)) event.preventDefault();
    // An island never merges into the page's markup beside it.
    if (edit.islands && (event.key === 'Backspace' || event.key === 'Delete') && atIslandEdge(event.key === 'Backspace')) event.preventDefault();
  }

  /** Whether the caret stands at the start (`start`) or the end of its island, with nothing selected. */
  function atIslandEdge(start) {
    var selection = getSelection();
    if (selection.rangeCount === 0 || !selection.isCollapsed) return false;
    var caret = selection.getRangeAt(0);
    var at = caret.startContainer.nodeType === 1 ? caret.startContainer : caret.startContainer.parentElement;
    var island = at === null ? null : at.closest('[data-stet-island]');
    if (island === null) return false;
    var range = document.createRange();
    if (start) {
      range.setStart(island, 0);
      range.setEnd(caret.startContainer, caret.startOffset);
    } else {
      range.setStart(caret.startContainer, caret.startOffset);
      range.setEnd(island, island.childNodes.length);
    }
    return range.toString() === '';
  }

  // Condition 4: every child is removed and the held nodes re-appended, each held
  // text node given its original text back only while it still holds what the
  // edit left at the last `input`. A held node that was a child at the last
  // `input` and is not now was moved by React: nothing is put back. The runs
  // form unwraps each island to its held text node with its original text.
  function end(how) {
    if (edit === null) return;
    var e = edit;
    edit = null;
    clearTimeout(e.pendingTimer);
    e.observer.disconnect();
    var el = e.el;
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    editListeners(el, 'removeEventListener');
    if (e.islands) {
      e.islands.forEach(function (island, i) {
        e.nodes[i].data = e.data[i];
        if (island.parentNode !== null) island.parentNode.replaceChild(e.nodes[i], island);
      });
    } else {
      var moved = e.nodes.some(function (n, i) { return e.attached[i] && n.parentNode !== el; });
      if (el.isConnected && !moved) {
        while (el.firstChild) el.removeChild(el.firstChild);
        e.nodes.forEach(function (n, i) {
          if (n.nodeType === 3 && n.data === e.last[i]) n.data = e.data[i];
          el.appendChild(n);
        });
      }
    }
    giveBack(e.lent);
    settle();
    tell({ stet: 'edited', key: e.key, locale: e.locale, entry: e.entry, how: how, proposed: e.proposed });
    // The drafts show by the ordinary swap again, without an answer of their own, and the census reads the page as it stands.
    if (last !== null) locate(last, false, undefined, true);
    else if (lastLayer !== null) layer(lastLayer);
    runCensus();
  }

  /**
   * The swaps standing inside `el` leave both lists while it is typed in, so no
   * restore or re-apply writes into it; `giveBack` returns each whose node
   * holds this script's write again once the edit has put its nodes back.
   */
  function lend(el) {
    var lent = [];
    var keep = function (list, inLayer) {
      return list.filter(function (s) {
        if (!s.node || !el.contains(s.node)) return true;
        lent.push({ swap: s, inLayer: inLayer });
        return false;
      });
    };
    swapped = keep(swapped, false);
    layered = keep(layered, true);
    return lent;
  }
  function giveBack(lent) {
    lent.forEach(function (l) {
      if (l.swap.node.data === l.swap.wrote) (l.inLayer ? layered : swapped).push(l.swap);
    });
  }

  /**
   * The page's `edit`: the selected element's hit for the key starts the
   * in-place form (`whole`) or the runs form (a mark). Where no such hit stands
   * the edit is answered `lost` at once, which moves it to the dashboard's field.
   */
  function beginEdit(data) {
    if (edit !== null && edit.key === data.key && edit.locale === data.locale && edit.entry === data.entry) return;
    end('keep');
    var hit;
    if (mode === 'edit' && selEl !== null && selEl.isConnected) {
      hit = (hits.get(selEl) || []).filter(function (h) {
        return h.key === data.key && h.entry === data.entry && (h.by === 'mark') === (data.form === 'runs') && inplaceHit(selEl, h);
      })[0];
    }
    if (hit === undefined) {
      tell({ stet: 'edited', key: data.key, locale: data.locale, entry: data.entry, how: 'lost', proposed: false });
      return;
    }
    var lent = lend(selEl);
    if (data.form === 'runs') startRuns(selEl, data.key, data.locale, data.entry, data.oneLine);
    else startInplace(selEl, hit.node, data.key, data.locale, data.entry, data.oneLine);
    edit.lent = lent;
  }

  // ---- Messages from the dashboard ----

  var isTexts = function (value) { return Array.isArray(value) && value.every(function (t) { return typeof t === 'string'; }); };
  // A list entry's index or a record field's name.
  var isEntry = function (value) {
    return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
  };

  /** A census payload's keys, each read into a fresh record; one of the wrong shape is dropped. */
  function censusKeys(keys) {
    var out = [];
    keys.forEach(function (k) {
      if (!k || typeof k !== 'object' || typeof k.key !== 'string' || !isTexts(k.texts)) return;
      var parts = Array.isArray(k.parts)
        ? k.parts.filter(function (p) { return p && typeof p === 'object' && isEntry(p.entry) && isTexts(p.texts); })
          .map(function (p) { return { entry: p.entry, texts: p.texts.slice() }; })
        : [];
      out.push({ key: k.key, texts: k.texts.slice(), parts: parts });
    });
    return out;
  }

  /** A layer's drafts, each read into a fresh record; one of the wrong shape is dropped. */
  function layerDrafts(drafts) {
    var out = [];
    drafts.forEach(function (d) {
      if (!d || typeof d !== 'object' || typeof d.key !== 'string' || !isTexts(d.texts) || typeof d.draft !== 'string') return;
      if (d.tags !== undefined && typeof d.tags !== 'number') return;
      if (d.entry !== undefined && !isEntry(d.entry)) return;
      out.push({ key: d.key, texts: d.texts.slice(), draft: d.draft, tags: d.tags, entry: d.entry });
    });
    return out;
  }

  function editRequest(data) {
    return typeof data.key === 'string' && typeof data.locale === 'string' && (data.entry === undefined || isEntry(data.entry))
      && (data.form === 'inplace' || data.form === 'runs') && typeof data.oneLine === 'boolean';
  }

  // ---- Hydration, the observer, and the page's own navigation ----

  var HOLD_QUIET_MS = 200;
  var hydrated = !hold;
  var loaded = document.readyState !== 'loading';
  var holdTimer = null;
  var ready = function () { tell({ stet: 'ready', route: location.pathname }); };
  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    clearTimeout(holdTimer);
    ready();
  }
  function holdQuiet() {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(hydrate, HOLD_QUIET_MS);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    // The dashboard asks after every load of the frame, so a `ready` sent
    // before the frame's load reached it is sent again after it.
    if (data.stet === 'hello') { if (hydrated) ready(); return; }
    // Nothing is read before hydration, so nothing is written before it.
    if (!hydrated) return;
    if (data.stet === 'locate' && typeof data.key === 'string' && Array.isArray(data.texts)) locate(data, data.scroll === true);
    else if (data.stet === 'clear') { last = null; end('keep'); clear(); clearLayer(); select(null); declined = []; }
    else if (data.stet === 'census' && Array.isArray(data.keys)) { payload = censusKeys(data.keys); buildIndex(); runCensus(); }
    else if (data.stet === 'reads' && typeof data.route === 'string' && (data.keys === null || isTexts(data.keys))) {
      reads = data.keys === null ? null : { route: data.route, keys: new Set(data.keys) };
      buildIndex();
      runCensus();
    }
    else if (data.stet === 'layer' && Array.isArray(data.drafts)) layer(layerDrafts(data.drafts));
    else if (data.stet === 'mode' && (data.mode === 'edit' || data.mode === 'use')) setMode(data.mode);
    else if (data.stet === 'edit' && editRequest(data)) beginEdit(data);
    else if (data.stet === 'end' && (data.how === 'keep' || data.how === 'cancel')) end(data.how);
  });

  // A page leaving the frame says so, so the dashboard stops posting before a
  // page it navigated to could receive anything.
  window.addEventListener('pagehide', function () { endSettle(); tell({ stet: 'bye' }); });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onViewport, true);
  window.addEventListener('resize', onViewport);

  // The app's own navigation, in Edit and Use: a new path or query is
  // reported, and the census runs again once the new page has had its first
  // quiet window. `replaceState` reports only where it is given a URL.
  var route = location.pathname + location.search;
  var censusSoon = null;
  function followed(how) {
    var now = location.pathname + location.search;
    if (now === route) return;
    route = now;
    // The reads were the last path's: until the dashboard sends this one's, every key is matched.
    buildIndex();
    tell({ stet: 'moved', how: how, route: now });
    clearTimeout(censusSoon);
    censusSoon = setTimeout(runCensus, 200);
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function (state, title, url) {
      var result = original.apply(this, arguments);
      if (name === 'pushState' || (arguments.length > 2 && url !== undefined && url !== null)) followed(name);
      return result;
    };
  });
  window.addEventListener('popstate', function () { followed('popstate'); });

  // A dev server that re-renders part of the page in place keeps the outline
  // and the drafts on it, and the census follows what the page now shows.
  // This script's own changes are taken off the observer's queue as they are
  // made, so they never re-trigger it.
  var again = null;
  var follow = null;
  var observer = new MutationObserver(function (records) {
    watchConnected();
    adopt(records);
    if (!hydrated) {
      if (loaded) holdQuiet();
      return;
    }
    if (quiet !== null) quiet.again();
    else if (last !== null) {
      clearTimeout(again);
      again = setTimeout(function () { if (last !== null) locate(last, false); }, 200);
    }
    if (lastLayer === null && index === null) return;
    clearTimeout(follow);
    follow = setTimeout(function () {
      // A standing locate applies the layer again itself.
      if (lastLayer !== null && (last === null || quiet !== null)) layer(lastLayer);
      runCensus();
    }, 200);
  });
  function settle() { observer.takeRecords(); }
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Without a hold the page is announced as soon as it is parsed. With one,
  // the earlier of `load` and two animation frames, or the first 200 ms with no
  // mutation after the document is parsed.
  if (hold) {
    var afterLoad = function () { requestAnimationFrame(function () { requestAnimationFrame(hydrate); }); };
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad);
    if (loaded) holdQuiet();
    else document.addEventListener('DOMContentLoaded', function () { loaded = true; holdQuiet(); });
  } else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
