/**
 * The preview agent (`templates/preview-agent.js`) inside a framed page, under
 * jsdom, through the frame harness in `helpers/preview-frame.ts`: its stand-in
 * layout gives every element in the body a box 20 px high, 40 px below the one
 * before it in document order, starting at 1000, and none to an element under
 * `hidden`, an inline `display: none` or a closed <details> (outside its
 * summary). The frame's `scrollTo` is recorded.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT,
  DASHBOARD,
  DASHED,
  SOLID,
  boxOf,
  centred,
  closeFrames,
  frame,
  located,
  tick,
  type Framed,
  type Message,
} from './helpers/preview-frame.js';

afterEach(closeFrames);

const PAGE =
  '<h1>  Ship the copy  </h1>' +
  '<p id="hello">Hello <b>big</b> world</p>' +
  '<p id="price">Price 12</p>' +
  '<span data-stet="k_mark">Marked text</span>' +
  '<p id="twin">Marked text</p>';

describe('the preview agent', () => {
  it('announces itself to the dashboard window', async () => {
    const framed = await frame(PAGE);
    expect(framed.sent).toEqual([{ stet: 'ready', route: framed.win.location.pathname, channel: 'c1' }]);
  });

  it('outlines a text match, keeps its edges around the draft, scrolls it to the centre at once, and says so', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'New words', scroll: true });
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(h1.style.outline).toBe(SOLID);
    expect(h1.style.outlineOffset).toBe('2px');
    expect(h1.textContent).toBe('  New words  ');
    expect(framed.scrolls).toEqual([centred(h1)]);
    expect(reply).toMatchObject({ found: 1, draft: 'shown', by: 'text', key: 'k_title' });
  });

  it('puts the first key back when another is located', async () => {
    const framed = await frame(PAGE);
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'New words' });
    await framed.locate({ key: 'k_price', texts: ['Price {{n}}'] });
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(h1.textContent).toBe('  Ship the copy  ');
    expect(h1.style.outline).toBe('');
  });

  it('outlines the deepest element holding split text, and shows its draft after Save', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_hello', texts: ['Hello big world'], draft: 'Hi there' });
    const p = framed.doc.getElementById('hello') as HTMLElement;
    expect(p.style.outline).toBe(SOLID);
    expect(framed.doc.body.style.outline).toBe('');
    expect(p.textContent).toBe('Hello big world');
    expect(reply).toMatchObject({ found: 1, draft: 'after-save' });
  });

  it('prefers a mark to a text match elsewhere', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_mark', texts: ['Marked text'], guess: true });
    expect((framed.doc.querySelector('[data-stet]') as HTMLElement).style.outline).toBe(SOLID);
    expect((framed.doc.getElementById('twin') as HTMLElement).style.outline).toBe('');
    expect(reply).toMatchObject({ found: 1, by: 'mark' });
  });

  it("takes a draft into a meta mark's content", async () => {
    const framed = await frame(PAGE, 'c1', '<meta name="description" data-stet-content="k_meta" content="Old words">');
    const reply = await framed.locate({ key: 'k_meta', texts: ['Old words'], draft: 'New words' });
    expect(framed.doc.querySelector('meta')?.getAttribute('content')).toBe('New words');
    expect(reply).toMatchObject({ found: 1, by: 'mark', draft: 'shown' });
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'] });
    expect(framed.doc.querySelector('meta')?.getAttribute('content')).toBe('Old words');
  });

  it('matches a {{name}} variable to any run of text', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_price', texts: ['Price {{n}}'] });
    expect((framed.doc.getElementById('price') as HTMLElement).style.outline).toBe(SOLID);
    expect(reply).toMatchObject({ found: 1 });
  });

  it('shows a tagged draft in the page’s own styling, and one out of order after Save', async () => {
    const framed = await frame(
      '<h1 data-stet="k_h1">You may already have the data<span class="tail"> our AI lab partners need.</span></h1>' +
        '<p data-stet="k_p">Hello <b>big <i>world</i></b>!</p>' +
        '<p data-stet="k_br">  First line<br>second line.  </p>',
    );
    const html = (id: string): string => (framed.doc.querySelector(`[data-stet="${id}"]`) as HTMLElement).innerHTML;
    const h1 = html('k_h1');
    const p = html('k_p');
    const br = html('k_br');

    const headline = await framed.locate({ key: 'k_h1', tags: 1, draft: 'You may already have data<1> our AI partners need.</1>' });
    expect(headline).toMatchObject({ found: 1, by: 'mark', draft: 'shown' });
    expect(html('k_h1')).toBe('You may already have data<span class="tail"> our AI partners need.</span>');

    const nested = await framed.locate({ key: 'k_p', tags: 2, draft: 'Hi <1>large <2>earth</2></1>?' });
    expect(html('k_h1')).toBe(h1);
    expect(nested).toMatchObject({ draft: 'shown' });
    expect(html('k_p')).toBe('Hi <b>large <i>earth</i></b>?');

    const broken = await framed.locate({ key: 'k_br', tags: 1, draft: 'One<1/>two.' });
    expect(html('k_p')).toBe(p);
    expect(broken).toMatchObject({ draft: 'shown' });
    expect(html('k_br')).toBe('  One<br>two.  ');

    const reordered = await framed.locate({ key: 'k_p', tags: 2, draft: 'Hi <2>x</2><1>y</1>' });
    expect(html('k_br')).toBe(br);
    expect(reordered).toMatchObject({ found: 1, draft: 'after-save' });
    expect(html('k_p')).toBe(p);
  });

  it('shows a draft whose tags swap two sibling elements after Save, though every run has a place', async () => {
    const framed = await frame('<p data-stet="k_p">Hello <b>big</b> and <i>world</i>!</p>');
    const p = framed.doc.querySelector('p') as HTMLElement;
    const reply = await framed.locate({ key: 'k_p', tags: 2, draft: 'Hi <2>x</2> and <1>y</1>!' });
    expect(reply).toMatchObject({ found: 1, draft: 'after-save' });
    expect(p.innerHTML).toBe('Hello <b>big</b> and <i>world</i>!');
  });

  it('writes a `<1>` draft as text for a key that declares no tags', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'Ship <1>x</1>' });
    expect((framed.doc.querySelector('h1') as HTMLElement).textContent).toBe('  Ship <1>x</1>  ');
    expect((framed.doc.querySelector('h1') as HTMLElement).children).toHaveLength(0);
    expect(reply).toMatchObject({ found: 1, draft: 'shown' });
  });

  it('waits for Save with a tagged draft for a key found by its text', async () => {
    const framed = await frame(PAGE);
    const reply = await framed.locate({ key: 'k_hello', texts: ['Hello big world'], tags: 1, draft: 'Hi <1>large</1> world' });
    expect(reply).toMatchObject({ found: 1, by: 'text', draft: 'after-save' });
    expect((framed.doc.getElementById('hello') as HTMLElement).innerHTML).toBe('Hello <b>big</b> world');
  });

  it('waits for Save with a tagged draft found inside a longer paragraph', async () => {
    const framed = await frame('<p id="long">Intro: You may already have the data our AI lab partners need. More words after.</p>');
    const before = (framed.doc.getElementById('long') as HTMLElement).innerHTML;
    const reply = await framed.locate({
      key: 'k_h1',
      texts: ['You may already have the data our AI lab partners need.'],
      tags: 1,
      draft: 'You may already have data<1> our AI partners need.</1>',
    });
    expect(reply).toMatchObject({ found: 1, by: 'contained', draft: 'after-save' });
    expect((framed.doc.getElementById('long') as HTMLElement).innerHTML).toBe(before);
  });

  it('leaves an element’s text alone for a tagged draft of a key marked on its attribute (stage-5 R9)', async () => {
    const framed = await frame('<a data-stet-title="k" title="Hello big">Hello <b>big</b></a>');
    const reply = await framed.locate({ key: 'k', tags: 1, draft: 'Hi <1>x</1>' });
    expect(reply).toMatchObject({ found: 1, by: 'mark' });
    expect((framed.doc.querySelector('a') as HTMLElement).innerHTML).toBe('Hello <b>big</b>');
  });

  it('writes a tagged draft’s markup as text', async () => {
    const framed = await frame('<h1 data-stet="k_h1">Say<span class="tail"> hello.</span></h1>');
    const reply = await framed.locate({ key: 'k_h1', tags: 1, draft: '<img src=x onerror=alert(1)><1> hello.</1>' });
    expect(reply).toMatchObject({ draft: 'shown' });
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(h1.querySelector('img')).toBeNull();
    expect(h1.textContent).toBe('<img src=x onerror=alert(1)> hello.');
  });

  it('outlines a derived key’s source dashed, writes nothing there, and answers for the key picked', async () => {
    const framed = await frame('<h1 data-stet="hero">You may already have the data</h1>');
    const reply = await framed.locate({ key: 'share', mark: 'hero', dashed: true, draft: null, scroll: true, guess: true });
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(reply).toMatchObject({ key: 'share', found: 1, by: 'mark', draft: null });
    expect(h1.style.outline).toBe(DASHED);
    expect(h1.textContent).toBe('You may already have the data');
    expect(framed.scrolls).toEqual([centred(h1)]);
  });

  it('scrolls only when asked', async () => {
    const framed = await frame(PAGE);
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'], scroll: false });
    expect(framed.scrolls).toEqual([]);
  });

  it('ignores a locate from another origin, and one the page posts to itself', async () => {
    const framed = await frame(PAGE);
    const before = framed.sent.length;
    framed.send({ stet: 'locate', seq: 1, key: 'k', texts: ['Ship the copy'], draft: 'Hacked', scroll: true }, 'http://evil.example');
    framed.send({ stet: 'locate', seq: 2, key: 'k', texts: ['Ship the copy'], draft: 'Hacked', scroll: true }, DASHBOARD, framed.win);
    await tick();
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(h1.style.outline).toBe('');
    expect(h1.textContent).toBe('  Ship the copy  ');
    expect(framed.sent.length).toBe(before);
  });

  it('restores everything on clear', async () => {
    const framed = await frame(PAGE);
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'New words' });
    framed.send({ stet: 'clear' });
    await tick();
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    expect(h1.style.outline).toBe('');
    expect(h1.textContent).toBe('  Ship the copy  ');
  });

  it('re-outlines text the page replaced, and its own swap triggers nothing', async () => {
    const framed = await frame(PAGE);
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'New words' });
    await tick(400);
    expect(located(framed)).toHaveLength(1);
    // The page re-renders the heading in place, as a dev server's client does.
    const fresh = framed.doc.createElement('h1');
    fresh.textContent = 'Ship the copy';
    framed.doc.querySelector('h1')?.replaceWith(fresh);
    await tick(400);
    expect(located(framed)).toHaveLength(2);
    expect(fresh.style.outline).toBe(SOLID);
    expect(fresh.textContent).toBe('New words');
  });

  it('sends nothing but site copy and its own bookkeeping', async () => {
    const framed = await frame(PAGE);
    await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'New words', scroll: true });
    framed.send({ stet: 'hello' });
    framed.win.dispatchEvent(new framed.win.Event('pagehide'));
    await tick();
    const allowed = new Set(['stet', 'key', 'found', 'draft', 'route', 'channel', 'seq', 'by', 'hidden']);
    for (const message of framed.sent) expect(Object.keys(message).filter((k) => !allowed.has(k))).toEqual([]);
  });

  describe('lines, guesses and the handshake', () => {
    const LINES = '<h1>Ship <span>across your sites</span> <span>in seconds.</span></h1><p id="br">one<br>two</p>';

    it('finds a value rendered line by line, dashed as a guess, and maps a draft of as many lines', async () => {
      const framed = await frame(LINES);
      const reply = await framed.locate({
        key: 'k_lines',
        texts: ['across your sites\nin seconds.'],
        draft: 'over every site\nright now.',
        guess: true,
      });
      const spans = [...framed.doc.querySelectorAll('span')] as HTMLElement[];
      expect(reply).toMatchObject({ found: 2, by: 'text', draft: 'shown' });
      expect(spans.map((s) => s.style.outline)).toEqual([DASHED, DASHED]);
      expect(spans.map((s) => s.textContent)).toEqual(['over every site', 'right now.']);
      expect((framed.doc.querySelector('h1') as HTMLElement).style.outline).toBe('');
    });

    it('shows a draft of another line count after Save', async () => {
      const framed = await frame(LINES);
      const reply = await framed.locate({ key: 'k_lines', texts: ['across your sites\nin seconds.'], draft: 'one line now' });
      expect(reply).toMatchObject({ found: 2, draft: 'after-save' });
      expect([...framed.doc.querySelectorAll('span')].map((s) => s.textContent)).toEqual(['across your sites', 'in seconds.']);
    });

    it('swaps both text nodes of one element under one outline, and gives its outline back', async () => {
      const framed = await frame(LINES);
      const reply = await framed.locate({ key: 'k_br', texts: ['one\ntwo'], draft: 'uno\ndos' });
      const p = framed.doc.getElementById('br') as HTMLElement;
      expect(reply).toMatchObject({ found: 2, draft: 'shown' });
      expect(p.style.outline).toBe(SOLID);
      expect([...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent)).toEqual(['uno', 'dos']);
      await framed.locate({ key: 'k_other', texts: ['nowhere on this page'] });
      expect(p.style.outline).toBe('');
      expect(p.textContent).toBe('onetwo');
    });

    it('outlines solid for guess: false, and solid on a mark whatever guess says', async () => {
      const framed = await frame(LINES + '<i data-stet="k_mark">Marked</i>');
      await framed.locate({ key: 'k_lines', texts: ['across your sites\nin seconds.'], guess: false });
      expect((framed.doc.querySelector('span') as HTMLElement).style.outline).toBe(SOLID);
      await framed.locate({ key: 'k_mark', texts: ['Marked'], guess: true });
      expect((framed.doc.querySelector('i') as HTMLElement).style.outline).toBe(SOLID);
    });

    it('answers hello with ready, says bye on pagehide, carries the channel, and echoes seq', async () => {
      const framed = await frame(LINES);
      framed.send({ stet: 'hello' });
      await tick();
      framed.send({ stet: 'locate', seq: 7, key: 'k', texts: ['one\ntwo'], draft: null, scroll: false });
      await tick();
      framed.win.dispatchEvent(new framed.win.Event('pagehide'));
      await tick();
      expect(framed.sent.map((m) => m['stet'])).toEqual(['ready', 'ready', 'located', 'bye']);
      expect(framed.sent.every((m) => m['channel'] === 'c1')).toBe(true);
      expect(located(framed)[0]?.['seq']).toBe(7);
    });

    it('sends nothing without a channel on its tag', async () => {
      const framed = await frame(LINES, null);
      framed.send({ stet: 'hello' });
      framed.send({ stet: 'locate', seq: 1, key: 'k', texts: ['one\ntwo'], draft: null, scroll: false });
      await tick();
      expect(framed.sent).toEqual([]);
    });
  });

  describe('one agent, drafts as text, and variables in linear time', () => {
    it('runs once in a page that carries its tag twice', async () => {
      const framed = await frame(PAGE);
      const again = framed.doc.createElement('script');
      again.setAttribute('data-parent', DASHBOARD);
      again.setAttribute('data-channel', 'c1');
      again.textContent = AGENT;
      framed.doc.body.appendChild(again);
      await tick();
      const before = framed.sent.length;
      framed.send({ stet: 'hello' });
      await framed.locate({ key: 'k_title', texts: ['Ship the copy'] });
      expect(framed.sent.slice(before).map((m) => m['stet'])).toEqual(['ready', 'located']);
      expect(framed.sent.filter((m) => m['stet'] === 'ready')).toHaveLength(2);
    });

    it('writes a draft holding markup as text, in a text node and in an element of text nodes', async () => {
      const framed = await frame('<h1>Ship the copy</h1><p id="split"></p>');
      const split = framed.doc.getElementById('split') as HTMLElement;
      split.append('Two text ', 'nodes here');
      const draft = '<b>x</b><img src=x id=inj>';
      await framed.locate({ key: 'k1', texts: ['Ship the copy'], draft });
      expect((framed.doc.querySelector('h1') as HTMLElement).textContent).toBe(draft);
      const reply = await framed.locate({ key: 'k2', texts: ['Two text nodes here'], draft });
      expect(reply).toMatchObject({ found: 1, draft: 'shown' });
      expect(split.textContent).toBe(draft);
      expect(framed.doc.querySelectorAll('b, #inj')).toHaveLength(0);
    });

    it('matches a value with six variables against long near misses in well under 20 ms', async () => {
      const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
      const framed = await frame(Array.from({ length: 5 }, () => `<p>${words}</p>`).join(''));
      const value = '{{a}} {{b}} {{c}} {{d}} {{e}} {{f}} and a tail that never comes';
      const started = performance.now();
      framed.send({ stet: 'locate', seq: 1, key: 'k', texts: [value], draft: null, scroll: false });
      const spent = performance.now() - started;
      await tick();
      expect(located(framed).at(-1)).toMatchObject({ found: 0 });
      expect(spent).toBeLessThan(20);
      // The same test still finds what `.+?` found.
      const hit = await framed.locate({ key: 'k', texts: ['{{a}} word1 {{b}} word59'] });
      expect(hit).toMatchObject({ found: 5, by: 'text' });
      const miss = await framed.locate({ key: 'k', texts: ['word0 {{a}}{{b}} word1 word2'] });
      expect(miss).toMatchObject({ found: 0 });
    });
  });

  describe('closed disclosures, hidden text and the frame’s own scroll', () => {
    const FAQ =
      '<details id="d1"><summary>Question one</summary><p data-stet="k_a">Answer one</p></details>' +
      '<details id="d2" open><summary>Question two</summary><p data-stet="k_b">Answer two</p></details>' +
      '<details id="d3"><summary data-stet="k_q">Question three</summary><p>Answer three</p></details>' +
      '<details id="outer"><summary>Group</summary><details id="inner"><summary>Row</summary><p data-stet="k_deep">Deep answer</p></details></details>';
    const isOpen = (framed: Framed, id: string): boolean => (framed.doc.getElementById(id) as HTMLElement).hasAttribute('open');

    it('opens the closed <details> around a key before scrolling to it, and keeps it open while the key stays', async () => {
      const framed = await frame(FAQ);
      const reply = await framed.locate({ key: 'k_a', texts: ['Answer one'], scroll: true });
      const answer = framed.doc.querySelector('[data-stet="k_a"]') as HTMLElement;
      expect(isOpen(framed, 'd1')).toBe(true);
      expect(reply).toMatchObject({ found: 1, by: 'mark', hidden: false });
      expect(framed.scrolls).toEqual([centred(answer)]);
      // Typing re-locates the same key: the row stays open without closing in between.
      const toggles: string[] = [];
      new framed.win.MutationObserver((records) => toggles.push(...records.map((r) => r.attributeName ?? ''))).observe(
        framed.doc.getElementById('d1') as HTMLElement,
        { attributes: true },
      );
      await framed.locate({ key: 'k_a', texts: ['Answer one'], draft: 'Typed' });
      expect(isOpen(framed, 'd1')).toBe(true);
      expect(toggles).toEqual([]);
    });

    it('closes the <details> it opened when the key changes, and never one the visitor opened', async () => {
      const framed = await frame(FAQ);
      await framed.locate({ key: 'k_a', texts: ['Answer one'] });
      await framed.locate({ key: 'k_b', texts: ['Answer two'] });
      expect(isOpen(framed, 'd1')).toBe(false);
      expect(isOpen(framed, 'd2')).toBe(true);
      await framed.locate({ key: 'k_deep', texts: ['Deep answer'] });
      expect([isOpen(framed, 'outer'), isOpen(framed, 'inner'), isOpen(framed, 'd2')]).toEqual([true, true, true]);
      await framed.locate({ key: 'k_q', texts: ['Question three'] });
      expect([isOpen(framed, 'outer'), isOpen(framed, 'inner'), isOpen(framed, 'd3'), isOpen(framed, 'd2')]).toEqual([false, false, false, true]);
    });

    it('closes the <details> it opened on clear, and leaves one the visitor opened since', async () => {
      const framed = await frame(FAQ);
      await framed.locate({ key: 'k_deep', texts: ['Deep answer'] });
      framed.send({ stet: 'clear' });
      await tick();
      expect([isOpen(framed, 'outer'), isOpen(framed, 'inner'), isOpen(framed, 'd2')]).toEqual([false, false, true]);
      (framed.doc.getElementById('d1') as HTMLElement).setAttribute('open', '');
      await framed.locate({ key: 'k_a', texts: ['Answer one'] });
      await framed.locate({ key: 'k_b', texts: ['Answer two'] });
      expect(isOpen(framed, 'd1')).toBe(true);
    });

    it('leaves closed a <details> the page closes again, through every re-apply, until the key is picked anew', async () => {
      const framed = await frame(FAQ);
      const d1 = framed.doc.getElementById('d1') as HTMLElement;
      await framed.locate({ key: 'k_a', texts: ['Answer one'], scroll: true });
      expect(d1.hasAttribute('open')).toBe(true);
      const replies = located(framed).length;
      // An accordion that closes the row and re-renders a child, as the reviewer's fixture does.
      d1.removeAttribute('open');
      d1.appendChild(framed.doc.createElement('i'));
      await tick(700);
      expect(d1.hasAttribute('open')).toBe(false);
      expect(located(framed).length - replies).toBe(1);
      // Typing keeps it closed; picking the key again opens it.
      await framed.locate({ key: 'k_a', texts: ['Answer one'], draft: 'Typed' });
      expect(d1.hasAttribute('open')).toBe(false);
      await framed.locate({ key: 'k_a', texts: ['Answer one'], scroll: true });
      expect(d1.hasAttribute('open')).toBe(true);
    });

    it('centres a key in every scrolling box around it, innermost first, then the window', async () => {
      const framed = await frame(
        '<div id="outer" style="overflow-y: auto"><p>Filler</p><div id="inner" style="overflow-y: scroll"><p>More</p><p id="deep">Deep down words</p></div></div>',
      );
      const tops: Record<string, number> = { outer: 0, inner: 0 };
      const order: string[] = [];
      for (const [id, client] of [['outer', 200], ['inner', 150]] as const) {
        const box = framed.doc.getElementById(id) as HTMLElement;
        Object.defineProperty(box, 'scrollHeight', { value: 2000 });
        Object.defineProperty(box, 'clientHeight', { value: client });
        Object.defineProperty(box, 'scrollTop', {
          get: () => tops[id],
          set: (value: number) => {
            order.push(id);
            tops[id] = value;
          },
        });
      }
      const deep = framed.doc.getElementById('deep') as HTMLElement;
      await framed.locate({ key: 'k', texts: ['Deep down words'], scroll: true });
      const offset = (id: string, client: number): number =>
        boxOf(deep).top - boxOf(framed.doc.getElementById(id) as HTMLElement).top - (client - 20) / 2;
      expect(order).toEqual(['inner', 'outer']);
      expect(tops).toEqual({ inner: offset('inner', 150), outer: offset('outer', 200) });
      expect(framed.scrolls).toEqual([centred(deep)]);
    });

    it('says a key is hidden when every place it renders has no box, and scrolls to one that can be seen', async () => {
      const framed = await frame(
        '<div style="display: none"><p>Menu words here</p></div><p id="seen">Menu words here</p><nav hidden><p>Only hidden</p></nav>',
      );
      const both = await framed.locate({ key: 'k1', texts: ['Menu words here'], scroll: true });
      expect(both).toMatchObject({ found: 2, hidden: false });
      expect(framed.scrolls).toEqual([centred(framed.doc.getElementById('seen') as HTMLElement)]);
      const hidden = await framed.locate({ key: 'k2', texts: ['Only hidden'], scroll: true });
      // Hidden at first sight: answered as shown, and named hidden once the page has had a second to settle.
      expect(hidden).toMatchObject({ found: 1, hidden: false });
      await tick(1_100);
      expect(located(framed).at(-1)).toMatchObject({ key: 'k2', found: 1, hidden: true });
      expect(framed.scrolls).toHaveLength(1);
      const head = await framed.locate({ key: 'k3', texts: ['nowhere'] });
      expect(head).toMatchObject({ found: 0, hidden: false });
    }, 5_000);

    it('looks again when an entrance ends, and names a key hidden only if it still is (journey B19)', async () => {
      const framed = await frame('<div id="in" style="display: none"><h1 id="h">Arriving headline</h1></div><p id="other">Other words</p>');
      const first = await framed.locate({ key: 'k1', texts: ['Arriving headline'], scroll: true });
      expect(first).toMatchObject({ found: 1, hidden: false });
      expect(framed.scrolls).toHaveLength(0);
      // An end on an element that holds no hit changes nothing.
      const other = framed.doc.getElementById('other') as HTMLElement;
      other.dispatchEvent(new framed.win.Event('transitionend', { bubbles: true }));
      const wrap = framed.doc.getElementById('in') as HTMLElement;
      wrap.removeAttribute('style');
      wrap.dispatchEvent(new framed.win.Event('animationend', { bubbles: true }));
      expect(framed.scrolls).toEqual([centred(framed.doc.getElementById('h') as HTMLElement)]);
      await tick(1_100);
      expect(located(framed).filter((m) => m['hidden'] === true)).toEqual([]);
    }, 5_000);

    it('ends the wait when another key is picked', async () => {
      const framed = await frame('<nav hidden><p>Only hidden</p></nav><p>Seen words</p>');
      await framed.locate({ key: 'k2', texts: ['Only hidden'] });
      await framed.locate({ key: 'k3', texts: ['Seen words'] });
      await tick(1_100);
      expect(located(framed).filter((m) => m['hidden'] === true)).toEqual([]);
    }, 5_000);

    it('scrolls a site’s own scrolling box by scrollTop, then the frame’s window', async () => {
      const framed = await frame('<div id="box" style="overflow-y: auto"><p>Filler</p><p id="far">Far down words</p></div>');
      const box = framed.doc.getElementById('box') as HTMLElement;
      let top = 0;
      Object.defineProperty(box, 'scrollHeight', { value: 2000 });
      Object.defineProperty(box, 'clientHeight', { value: 300 });
      Object.defineProperty(box, 'scrollTop', { get: () => top, set: (value: number) => { top = value; } });
      const far = framed.doc.getElementById('far') as HTMLElement;
      await framed.locate({ key: 'k', texts: ['Far down words'], scroll: true });
      expect(top).toBe(boxOf(far).top - boxOf(box).top - (300 - 20) / 2);
      expect(framed.scrolls).toEqual([centred(far)]);
    });
  });

  describe('a value inside a longer text', () => {
    it('outlines a match inside more text dashed even when the page sends guess: false', async () => {
      const framed = await frame('<p>Plain Postgres — or no database at all, today.</p>');
      const reply = await framed.locate({ key: 'k', texts: ['Plain Postgres — or no database at all'], guess: false });
      expect(reply).toMatchObject({ found: 1, by: 'contained' });
      expect((framed.doc.querySelector('p') as HTMLElement).style.outline).toBe(DASHED);
    });

    // The website's quickstart paragraph: the key renders its first sentence,
    // and the template writes the rest.
    const REST = " A Postgres database is optional. If you don't have one, stet runs snapshot-only and keeps your copy in a committed file.";
    const PREREQ = 'You need Node 22 or newer and a git repository.';
    const QUICKSTART = `<main><h1>Quickstart</h1><p class="prereq lede">\n  ${PREREQ}${REST}</p><p id="other">Nothing here.</p></main>`;

    it('outlines the paragraph holding it, dashed, shows the draft in its place alone, and restores the text exactly', async () => {
      const framed = await frame(QUICKSTART);
      const p = framed.doc.querySelector('p.prereq') as HTMLElement;
      const before = p.textContent;
      const reply = await framed.locate({
        key: 'docs_quickstart_prereq',
        texts: [PREREQ],
        draft: 'You need Node 24 or later and a git repository.',
        scroll: true,
        guess: true,
      });
      expect(reply).toMatchObject({ found: 1, by: 'contained', draft: 'shown' });
      expect(p.style.outline).toBe(DASHED);
      expect((framed.doc.querySelector('main') as HTMLElement).style.outline).toBe('');
      expect(p.textContent).toBe(`\n  You need Node 24 or later and a git repository.${REST}`);
      expect(framed.scrolls).toEqual([centred(p)]);
      await framed.locate({ key: 'k_other', texts: ['nowhere on this page'] });
      expect(p.textContent).toBe(before);
      expect(p.style.outline).toBe('');
    });

    it('outlines every node holding it, scrolls to the first, and replaces each occurrence', async () => {
      const framed = await frame(
        `<p id="a">First: ${PREREQ} Then more.</p><div><span id="b">${PREREQ} Again, ${PREREQ}</span></div>`,
      );
      const reply = await framed.locate({ key: 'k', texts: [PREREQ], draft: 'Node 24.', scroll: true, guess: true });
      const a = framed.doc.getElementById('a') as HTMLElement;
      const b = framed.doc.getElementById('b') as HTMLElement;
      expect(reply).toMatchObject({ found: 3, by: 'contained', draft: 'shown' });
      expect([a.style.outline, b.style.outline]).toEqual([DASHED, DASHED]);
      expect(framed.scrolls).toEqual([centred(a)]);
      expect(b.textContent).toBe('Node 24. Again, Node 24.');
      framed.send({ stet: 'clear' });
      await tick();
      expect(a.textContent).toBe(`First: ${PREREQ} Then more.`);
      expect(b.textContent).toBe(`${PREREQ} Again, ${PREREQ}`);
    });

    it('matches at word edges only, and never a value under twelve characters or one holding a variable', async () => {
      const framed = await frame('<p>Every Postgres databases list and Node 22 notes, priced at 40 per seat today.</p>');
      const partWord = await framed.locate({ key: 'k1', texts: ['Postgres database'] });
      const short = await framed.locate({ key: 'k2', texts: ['Node 22'] });
      const variable = await framed.locate({ key: 'k3', texts: ['priced at {{n}} per seat'] });
      expect(partWord).toMatchObject({ found: 0, by: 'contained' });
      expect(short).toMatchObject({ found: 0 });
      expect(variable).toMatchObject({ found: 0 });
      expect((framed.doc.querySelector('p') as HTMLElement).style.outline).toBe('');
    });

    it('finds each line of a value inside longer texts, and maps a draft of as many lines', async () => {
      const framed = await frame(
        '<p id="l1">Lead-in: across your sites, then</p><p id="l2">and it lands in seconds, every time.</p>',
      );
      const reply = await framed.locate({
        key: 'k_lines',
        texts: ['across your sites\nit lands in seconds'],
        draft: 'over every site\nit lands at once',
        guess: true,
      });
      expect(reply).toMatchObject({ found: 2, by: 'contained', draft: 'shown' });
      expect((framed.doc.getElementById('l1') as HTMLElement).textContent).toBe('Lead-in: over every site, then');
      expect((framed.doc.getElementById('l2') as HTMLElement).textContent).toBe('and it lands at once, every time.');
    });
  });
});
