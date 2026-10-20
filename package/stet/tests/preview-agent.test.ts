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

  describe('a page that re-rendered after a save', () => {
    it('keeps the words the page wrote over a swapped node, even the very words the swap had put there (F89)', async () => {
      const framed = await frame(PAGE);
      await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'Fresh' });
      const h1 = framed.doc.querySelector('h1') as HTMLElement;
      // React updates the node in place to the saved text, which is the draft's text too.
      (h1.firstChild as Text).data = '  Fresh  ';
      await tick();
      // The save check runs: it restores what it swapped, and must not touch the page's text.
      const reply = await framed.locate({ key: 'k_title', texts: ['Fresh'], check: true });
      expect(h1.textContent).toBe('  Fresh  ');
      expect(reply).toMatchObject({ found: 1, by: 'text' });
      framed.send({ stet: 'clear' });
      await tick();
      expect(h1.textContent).toBe('  Fresh  ');
    });

    it('keeps the page’s words when the write has not reached the observer before the next request', async () => {
      const framed = await frame(PAGE);
      await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'Fresh' });
      const h1 = framed.doc.querySelector('h1') as HTMLElement;
      (h1.firstChild as Text).data = '  Fresh  ';
      // No tick between the write and the request: the record is still queued.
      await framed.locate({ key: 'k_price', texts: ['Price {{n}}'] });
      expect(h1.textContent).toBe('  Fresh  ');
    });

    it('leaves the page’s words on a node the page rewrote after it left the document, where no observer sees the write', async () => {
      const framed = await frame(PAGE);
      await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'Fresh' });
      const h1 = framed.doc.querySelector('h1') as HTMLElement;
      const text = h1.firstChild as Text;
      h1.remove();
      await tick();
      // The page keeps the detached node and rewrites it: nothing observes a node outside the document.
      text.data = 'Saved.';
      await tick();
      framed.send({ stet: 'clear' });
      await tick();
      expect(text.data).toBe('Saved.');
    });

    it('keeps the page’s attribute, and still restores a node the page left alone', async () => {
      const framed = await frame(PAGE, 'c1', '<meta name="description" data-stet-content="k_meta" content="Old words">');
      await framed.locate({ key: 'k_meta', texts: ['Old words'], draft: 'New words' });
      framed.doc.querySelector('meta')?.setAttribute('content', 'Saved words');
      await framed.locate({ key: 'k_title', texts: ['Ship the copy'], draft: 'Other draft' });
      expect(framed.doc.querySelector('meta')?.getAttribute('content')).toBe('Saved words');
      // The heading was swapped and never touched by the page: it comes back.
      await framed.locate({ key: 'k_price', texts: ['Price {{n}}'] });
      expect((framed.doc.querySelector('h1') as HTMLElement).textContent).toBe('  Ship the copy  ');
    });
  });

  describe('a save check on a page that renders after it announces itself', () => {
    const SPA = '<div id="root"></div>';
    const asked = async (framed: Framed, request: Message): Promise<number> => {
      const before = located(framed).length;
      framed.send({ stet: 'locate', seq: 1, texts: [], draft: null, scroll: false, ...request });
      return before;
    };

    it('waits for the page to go quiet, then answers with what rendered (F90)', async () => {
      const framed = await frame(SPA);
      const before = await asked(framed, { key: 'k_link', texts: ['Sign in here'], check: true, guess: true });
      await tick(100);
      expect(located(framed)).toHaveLength(before);
      // The app draws, in several bursts.
      const root = framed.doc.getElementById('root') as HTMLElement;
      root.innerHTML = '<main></main>';
      await tick(150);
      (root.firstChild as HTMLElement).innerHTML = '<a>Sign in here</a>';
      await tick(150);
      expect(located(framed)).toHaveLength(before);
      await tick(500);
      expect(located(framed).slice(before)).toEqual([expect.objectContaining({ key: 'k_link', found: 1, by: 'text' })]);
    });

    it('answers not found once, after the quiet window, when nothing ever renders', async () => {
      const framed = await frame(SPA);
      const before = await asked(framed, { key: 'k_link', texts: ['Sign in here'], check: true });
      await tick(150);
      expect(located(framed)).toHaveLength(before);
      await tick(500);
      expect(located(framed).slice(before)).toEqual([expect.objectContaining({ found: 0 })]);
    });

    it('answers a request that is not a save check at once, as before', async () => {
      const framed = await frame(SPA);
      const reply = await framed.locate({ key: 'k_link', texts: ['Sign in here'] });
      expect(reply).toMatchObject({ found: 0 });
    });

    it('a new request ends the wait', async () => {
      const framed = await frame(PAGE);
      const before = await asked(framed, { key: 'k_none', texts: ['Nowhere text'], check: true });
      await tick(50);
      const reply = await framed.locate({ key: 'k_title', texts: ['Ship the copy'] });
      expect(reply).toMatchObject({ key: 'k_title', found: 1 });
      await tick(600);
      expect(located(framed).slice(before).map((m) => m['key'])).toEqual(['k_title']);
    });
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

// ---- Editing from the preview (D7): the hold, the census, Edit mode, the in-place edit, the layer ----

interface CensusKey {
  key: string;
  texts: string[];
  parts?: Array<{ entry: number | string; texts: string[] }>;
}

const sentOf = (framed: Framed, stet: string): Message[] => framed.sent.filter((m) => m['stet'] === stet);
const lastOf = (framed: Framed, stet: string): Message | undefined => sentOf(framed, stet).at(-1);

async function censusOf(framed: Framed, keys: CensusKey[]): Promise<Message | undefined> {
  const before = framed.sent.length;
  framed.send({ stet: 'census', keys });
  await tick();
  return framed.sent.slice(before).find((m) => m['stet'] === 'census');
}

async function setMode(framed: Framed, mode: 'edit' | 'use'): Promise<void> {
  framed.send({ stet: 'mode', mode });
  await tick();
}

function press(framed: Framed, el: Element, type: string, init: MouseEventInit = {}): boolean {
  return el.dispatchEvent(new framed.win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

function key(framed: Framed, el: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new framed.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

/**
 * One keystroke as a browser delivers it: `beforeinput` at the editing host,
 * the DOM edit, the microtask checkpoint (the observers run), then `input`.
 */
async function keystroke(framed: Framed, host: Element, write: () => void, inputType = 'insertText'): Promise<void> {
  host.dispatchEvent(new framed.win.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
  write();
  await Promise.resolve();
  host.dispatchEvent(new framed.win.InputEvent('input', { inputType, bubbles: true }));
}

async function typeAtEnd(framed: Framed, host: Element, node: Text, chars: string): Promise<void> {
  for (const ch of chars) {
    await keystroke(framed, host, () => {
      node.data += ch;
    });
  }
  await tick();
}

function caret(framed: Framed, node: Node, offset: number): void {
  const selection = framed.win.getSelection() as Selection;
  selection.removeAllRanges();
  selection.collapse(node, offset);
}

/** The census holding `keys`, Edit on, a click on `el` (the pick) and the page's `edit` for `id`. */
async function editOn(framed: Framed, el: Element, keys: CensusKey[], id: string, extra: Message = {}): Promise<void> {
  await censusOf(framed, keys);
  await setMode(framed, 'edit');
  press(framed, el, 'click');
  framed.send({ stet: 'edit', key: id, locale: 'default', form: 'inplace', oneLine: true, ...extra });
  await tick();
}

const BUTTON: CensusKey[] = [{ key: 'lab_button', texts: ['Start free trial'] }];

describe('the hydration hold (6.1)', () => {
  it('with data-hold, sends no ready and reads nothing before load, then announces itself two frames after it', async () => {
    const framed = await frame('<h1>Ship the copy</h1>', 'c1', '', AGENT, { hold: true, loading: true });
    await tick(250);
    framed.doc.dispatchEvent(new framed.win.Event('DOMContentLoaded'));
    // The page keeps rendering, so no quiet window opens; a hello and a locate find no agent yet.
    for (let i = 0; i < 6; i += 1) {
      framed.doc.body.appendChild(framed.doc.createElement('i'));
      await tick(60);
    }
    framed.send({ stet: 'hello' });
    framed.send({ stet: 'locate', seq: 1, key: 'k', texts: ['Ship the copy'], draft: 'Early', scroll: false });
    await tick();
    expect(framed.sent).toEqual([]);
    expect((framed.doc.querySelector('h1') as HTMLElement).textContent).toBe('Ship the copy');
    Object.defineProperty(framed.doc, 'readyState', { value: 'complete', configurable: true });
    framed.win.dispatchEvent(new framed.win.Event('load'));
    await tick(80);
    expect(framed.sent.map((m) => m['stet'])).toEqual(['ready']);
  });

  it('with data-hold, takes no census, layer, mode, edit or end before hydration, and writes nothing', async () => {
    const framed = await frame('<h1>Ship the copy</h1>', 'c1', '', AGENT, { hold: true, loading: true });
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    let clicks = 0;
    h1.addEventListener('click', () => (clicks += 1));
    framed.doc.dispatchEvent(new framed.win.Event('DOMContentLoaded'));
    framed.send({ stet: 'census', keys: [{ key: 'k', texts: ['Ship the copy'] }] });
    framed.send({ stet: 'layer', drafts: [{ key: 'k', texts: ['Ship the copy'], draft: 'Early' }] });
    framed.send({ stet: 'mode', mode: 'edit' });
    framed.send({ stet: 'edit', key: 'k', locale: 'default', form: 'inplace', oneLine: true });
    framed.send({ stet: 'end', how: 'keep' });
    framed.send({ stet: 'clear' });
    await tick();
    press(framed, h1, 'click');
    expect(framed.sent).toEqual([]);
    expect(h1.textContent).toBe('Ship the copy');
    expect(h1.hasAttribute('contenteditable')).toBe(false);
    expect(clicks).toBe(1);
  });

  it('with data-hold, announces itself after the first 200 ms with no mutation once the document is parsed', async () => {
    const framed = await frame('<h1>Ship the copy</h1>', 'c1', '', AGENT, { hold: true, loading: true });
    framed.doc.dispatchEvent(new framed.win.Event('DOMContentLoaded'));
    await tick(120);
    expect(framed.sent).toEqual([]);
    await tick(200);
    expect(framed.sent.map((m) => m['stet'])).toEqual(['ready']);
  });

  it('without data-hold, announces itself as soon as the document is parsed', async () => {
    const framed = await frame('<h1>Ship the copy</h1>', 'c1', '', AGENT, { loading: true });
    framed.doc.dispatchEvent(new framed.win.Event('DOMContentLoaded'));
    expect(framed.sent).toEqual([]);
    await tick(0);
    expect(framed.sent.map((m) => m['stet'])).toEqual(['ready']);
  });
});

describe('the census (6.2)', () => {
  // The Next lab's /lab, reduced to one of each shape the census reports.
  const LAB =
    '<img id="hero" src="x.png" alt="A desk with two laptops">' +
    '<button id="close" aria-label="Close this panel">×</button>' +
    '<input id="search" placeholder="Search every page">' +
    '<ul><li>Fast setup for teams</li><li>One file per site</li><li>No deploy to change words</li></ul>' +
    '<dl><dt>Plans for every team</dt><dd>Pay only for the seats you use</dd></dl>' +
    '<nav><a>Talk to our team</a></nav><footer><a>Talk to our team</a></footer>' +
    '<p id="greet">Welcome back, Maya.</p>';
  const LAB_KEYS: CensusKey[] = [
    { key: 'lab_hero_alt', texts: ['A desk with two laptops'] },
    { key: 'lab_close_label', texts: ['Close this panel'] },
    { key: 'lab_search_placeholder', texts: ['Search every page'] },
    {
      key: 'lab_list',
      texts: [],
      parts: [
        { entry: 0, texts: ['Fast setup for teams'] },
        { entry: 1, texts: ['One file per site'] },
        { entry: 2, texts: ['No deploy to change words'] },
      ],
    },
    { key: 'lab_record', texts: [], parts: [{ entry: 'title', texts: ['Plans for every team'] }, { entry: 'body', texts: ['Pay only for the seats you use'] }] },
    { key: 'lab_shared', texts: ['Talk to our team'] },
    { key: 'lab_greeting', texts: ['Welcome back, {{name}}.'] },
    { key: 'lab_absent', texts: ['Nowhere on this page'] },
  ];

  it('finds attributes, list entries, record fields, a shared key twice and a {{name}} key by pattern (journey B26)', async () => {
    const framed = await frame(LAB);
    const reply = await censusOf(framed, LAB_KEYS);
    expect(reply).toMatchObject({
      found: { lab_hero_alt: 1, lab_close_label: 1, lab_search_placeholder: 1, lab_list: 3, lab_record: 2, lab_shared: 2, lab_greeting: 1 },
      entries: { lab_list: [0, 1, 2], lab_record: ['title', 'body'] },
      ambiguous: [],
      weak: [],
      route: framed.win.location.pathname,
    });
    expect(Object.keys(reply?.['found'] as object)).not.toContain('lab_absent');
    // What a click on each attribute's element reports.
    await setMode(framed, 'edit');
    const picked = async (id: string): Promise<unknown> => {
      press(framed, framed.doc.getElementById(id) as HTMLElement, 'click');
      await tick();
      return lastOf(framed, 'pick')?.['keys'];
    };
    expect(await picked('hero')).toEqual([{ key: 'lab_hero_alt', attr: 'alt', by: 'attr', inplace: false }]);
    expect(await picked('close')).toEqual([{ key: 'lab_close_label', attr: 'aria-label', by: 'attr', inplace: false }]);
    expect(await picked('search')).toEqual([{ key: 'lab_search_placeholder', attr: 'placeholder', by: 'attr', inplace: false }]);
    expect(await picked('greet')).toEqual([{ key: 'lab_greeting', attr: null, by: 'pattern', inplace: false }]);
  });

  it('reads a node that shows a draft as the page holds it, so the key is still found and picked there', async () => {
    const framed = await frame('<h2 id="a">Pricing plans for teams</h2><p id="b">Talk to our sales team</p>');
    await framed.locate({ key: 'k_a', texts: ['Pricing plans for teams'], draft: 'Plans' });
    framed.send({ stet: 'layer', drafts: [{ key: 'k_b', texts: ['Talk to our sales team'], draft: 'Talk to us' }] });
    const reply = await censusOf(framed, [
      { key: 'k_a', texts: ['Pricing plans for teams'] },
      { key: 'k_b', texts: ['Talk to our sales team'] },
    ]);
    expect((framed.doc.getElementById('a') as HTMLElement).textContent).toBe('Plans');
    expect(reply?.['found']).toEqual({ k_a: 1, k_b: 1 });
  });

  it('names two keys that share one text as ambiguous, and a key found only by a short fragment as weak', async () => {
    const framed = await frame('<nav><a>Pricing</a></nav><p>Updated <span>·</span> today</p>');
    const reply = await censusOf(framed, [
      { key: 'nav_pricing', texts: ['Pricing'] },
      { key: 'footer_pricing', texts: ['Pricing'] },
      { key: 'meta_dot', texts: ['·'] },
    ]);
    expect(reply).toMatchObject({ found: { nav_pricing: 1, footer_pricing: 1, meta_dot: 1 }, ambiguous: [['nav_pricing', 'footer_pricing']], weak: ['meta_dot'] });
  });

  it('finds a {{name}} text by the word before its first variable, and one whose first word runs into a variable or that opens with one', async () => {
    const framed = await frame('<p>Hello Maya, item 10 is ready</p><p>Order42 shipped</p><p>3 seats left today</p><p>Hello Sam, nothing here</p>');
    const reply = await censusOf(framed, [
      { key: 'k_hello', texts: ['Hello {{name}}, item {{n}} is ready'] },
      { key: 'k_order', texts: ['Order{{id}} shipped'] },
      { key: 'k_seats', texts: ['{{n}} seats left today'] },
      { key: 'k_all', texts: ['{{a}} {{b}}'] },
    ]);
    expect(reply?.['found']).toEqual({ k_hello: 1, k_order: 1, k_seats: 1 });
  });

  it('reports the keys the title and the head’s description metas show', async () => {
    const framed = await frame(
      '<h1>Plans and pricing</h1>',
      'c1',
      '<title>Acme pricing</title><meta name="description" content="Plans for teams of every size"><meta property="og:title" content="Acme, priced per seat">',
    );
    const reply = await censusOf(framed, [
      { key: 'seo_title', texts: ['Acme pricing'] },
      { key: 'seo_description', texts: ['Plans for teams of every size'] },
      { key: 'share_title', texts: ['Acme, priced per seat'] },
    ]);
    expect(reply?.['head']).toEqual([
      { key: 'seo_title', where: 'title' },
      { key: 'seo_description', where: 'description' },
      { key: 'share_title', where: 'og:title' },
    ]);
  });

  it('D40: reports the keys the Twitter share tags show, by the tag’s name', async () => {
    const framed = await frame(
      '<h1>Plans and pricing</h1>',
      'c1',
      '<meta name="twitter:title" content="Acme on Twitter"><meta property="twitter:description" content="Priced per seat, billed monthly">',
    );
    const reply = await censusOf(framed, [
      { key: 'tweet_title', texts: ['Acme on Twitter'] },
      { key: 'tweet_description', texts: ['Priced per seat, billed monthly'] },
    ]);
    expect(reply?.['head']).toEqual([
      { key: 'tweet_title', where: 'twitter:title' },
      { key: 'tweet_description', where: 'twitter:description' },
    ]);
    expect(reply?.['found']).toEqual({ tweet_title: 1, tweet_description: 1 });
  });

  it('D38: reads a <br> as a line break, so a multi-line key is found in the one element that holds its lines', async () => {
    const framed = await frame('<p id="two">Welcome<br>friends</p><p id="three">First<br>second<br> third </p><p id="nest"><span>Left<br></span>right</p>');
    const reply = await censusOf(framed, [
      { key: 'k_two', texts: ['Welcome\nfriends'] },
      { key: 'k_three', texts: ['First\nsecond\nthird'] },
      { key: 'k_nest', texts: ['Left\nright'] },
    ]);
    expect(reply?.['found']).toEqual({ k_two: 1, k_three: 1, k_nest: 1 });
  });

  it('lets the marks decide on an html page, and adds an alt no mark names', async () => {
    const framed = await frame(
      '<h1 data-stet="hero">Ship it now</h1><p>Words another key holds</p>' +
        '<img src="a.png" alt="The Acme logo"><img src="b.png" alt="A marked alt" data-stet-alt="marked_alt">',
    );
    const reply = await censusOf(framed, [
      { key: 'hero', texts: ['Ship it now'] },
      { key: 'other', texts: ['Words another key holds'] },
      { key: 'logo_alt', texts: ['The Acme logo'] },
      { key: 'marked_alt', texts: ['A marked alt'] },
      { key: 'twin_alt', texts: ['A marked alt'] },
    ]);
    expect(reply?.['found']).toEqual({ hero: 1, marked_alt: 1, logo_alt: 1 });
  });

  it('finds a text inside more text by its first word, bounded on both sides, the longer of two at one place', async () => {
    const edges = await frame(
      '<p id="beta">(beta) Start your free trial</p><p id="glued">xShip copy without a deploy</p><p id="plural">Ship copy without a deploys</p>',
    );
    const bounded = await censusOf(edges, [
      { key: 'trial', texts: ['Start your free trial'] },
      { key: 'ship_long', texts: ['Ship copy without a deploy'] },
    ]);
    expect(bounded?.['found']).toEqual({ trial: 1 });
    const framed = await frame('<p id="both">Now: Ship copy without a deploy, today.</p>');
    const reply = await censusOf(framed, [
      { key: 'ship_long', texts: ['Ship copy without a deploy'] },
      { key: 'ship_short', texts: ['Ship copy without'] },
    ]);
    expect(reply?.['found']).toEqual({ ship_long: 1 });
    await setMode(framed, 'edit');
    press(framed, framed.doc.getElementById('both') as HTMLElement, 'click');
    await tick();
    expect(lastOf(framed, 'pick')?.['keys']).toEqual([{ key: 'ship_long', attr: null, by: 'contained', inplace: false }]);
  });
});

describe('Edit mode (6.3)', () => {
  const PAGE_HANDLERS =
    '<a id="link" href="#moved">Read the pricing guide</a>' +
    '<button id="btn">Start free trial</button>' +
    '<details id="faq"><summary id="sum">Questions and answers</summary><p>Hidden answer text</p></details>' +
    '<span id="inline" onclick="window.__ran = (window.__ran || 0) + 1">Inline handler copy</span>' +
    '<p id="plain">Text no key holds</p><input id="field">';
  const HANDLER_KEYS: CensusKey[] = [
    { key: 'lab_link', texts: ['Read the pricing guide'] },
    { key: 'lab_button', texts: ['Start free trial'] },
    { key: 'lab_summary', texts: ['Questions and answers'] },
    { key: 'lab_inline', texts: ['Inline handler copy'] },
  ];

  async function handlerPage(): Promise<{ framed: Framed; counts: Record<string, number> }> {
    const framed = await frame(PAGE_HANDLERS);
    const counts: Record<string, number> = { click: 0, mousedown: 0 };
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    btn.addEventListener('click', () => (counts['click'] = (counts['click'] ?? 0) + 1));
    btn.addEventListener('mousedown', () => (counts['mousedown'] = (counts['mousedown'] ?? 0) + 1));
    await censusOf(framed, HANDLER_KEYS);
    return { framed, counts };
  }

  it('picks each key a click lands on and lets no link, button, summary or inline handler act (journey B23)', async () => {
    const { framed, counts } = await handlerPage();
    await setMode(framed, 'edit');
    for (const id of ['link', 'btn', 'sum', 'inline']) {
      press(framed, framed.doc.getElementById(id) as HTMLElement, 'click');
      await tick();
    }
    expect(sentOf(framed, 'pick').map((m) => (m['keys'] as Message[]).map((k) => k['key']))).toEqual([
      ['lab_link'],
      ['lab_button'],
      ['lab_summary'],
      ['lab_inline'],
    ]);
    expect(framed.win.location.hash).toBe('');
    expect(counts['click']).toBe(0);
    expect((framed.doc.getElementById('faq') as HTMLElement).hasAttribute('open')).toBe(false);
    expect((framed.win as unknown as { __ran?: number }).__ran).toBeUndefined();
    const pick = sentOf(framed, 'pick')[1] as Message;
    expect(pick).toMatchObject({ tag: 'button', again: false, rect: { left: 0, width: 200, height: 20 } });
    expect((pick['keys'] as Message[])[0]).toEqual({ key: 'lab_button', attr: null, by: 'whole', inplace: true });
  });

  it('keeps a press’s default while the page’s own handlers never see it', async () => {
    const { framed, counts } = await handlerPage();
    await setMode(framed, 'edit');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    expect(press(framed, btn, 'mousedown')).toBe(true);
    expect(counts['mousedown']).toBe(0);
  });

  it('gives the page back in Use: the listeners are gone and a click acts', async () => {
    const { framed, counts } = await handlerPage();
    await setMode(framed, 'edit');
    await setMode(framed, 'use');
    press(framed, framed.doc.getElementById('btn') as HTMLElement, 'click');
    expect(press(framed, framed.doc.getElementById('btn') as HTMLElement, 'mousedown')).toBe(true);
    await tick();
    expect(counts).toEqual({ click: 1, mousedown: 1 });
    expect(sentOf(framed, 'pick')).toEqual([]);
  });

  it('sends key: save for Cmd-S and Ctrl-S and prevents it, and E outside a field switches the mode', async () => {
    const { framed } = await handlerPage();
    const body = framed.doc.body;
    expect(key(framed, body, { key: 's', metaKey: true }).defaultPrevented).toBe(true);
    expect(key(framed, body, { key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
    key(framed, framed.doc.getElementById('field') as HTMLElement, { key: 'e' });
    key(framed, body, { key: 'e' });
    await tick();
    expect(sentOf(framed, 'key').map((m) => m['which'])).toEqual(['save', 'save', 'mode']);
  });

  it('rings the copy under the pointer, says what it is, and lets its own box-shadow back when it leaves', async () => {
    const { framed } = await handlerPage();
    await setMode(framed, 'edit');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    btn.style.boxShadow = '1px 1px red';
    btn.dispatchEvent(new framed.win.MouseEvent('pointerover', { bubbles: true }));
    expect(btn.style.boxShadow).toBe('0 0 0 1px hsl(38 92% 50% / .9)');
    (framed.doc.getElementById('plain') as HTMLElement).dispatchEvent(new framed.win.MouseEvent('pointerover', { bubbles: true }));
    await tick();
    expect(btn.style.boxShadow).toBe('1px 1px red');
    expect(sentOf(framed, 'hover')).toEqual([
      { stet: 'hover', keys: [{ key: 'lab_button', attr: null, by: 'whole' }], tag: 'button', rect: expect.objectContaining({ height: 20 }), inplace: true, channel: 'c1' },
      { stet: 'hover', keys: [], channel: 'c1' },
    ]);
  });

  it('says a click on text no key matches is unmanaged, and sends a second pick as again', async () => {
    const { framed } = await handlerPage();
    await setMode(framed, 'edit');
    press(framed, framed.doc.getElementById('plain') as HTMLElement, 'click');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    // A double click: two presses and two clicks, then the dblclick.
    for (const detail of [1, 2]) {
      press(framed, btn, 'mousedown', { detail });
      press(framed, btn, 'click', { detail });
    }
    press(framed, btn, 'dblclick', { detail: 2 });
    // Enter on the selection.
    key(framed, framed.doc.body, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'unmanaged')).toEqual({ stet: 'unmanaged', text: 'Text no key holds', tag: 'p', channel: 'c1' });
    expect(sentOf(framed, 'pick').map((m) => m['again'])).toEqual([false, true, true]);
  });

  it('sends the selected element’s box when the frame scrolls, at most once a frame', async () => {
    const { framed } = await handlerPage();
    await setMode(framed, 'edit');
    press(framed, framed.doc.getElementById('btn') as HTMLElement, 'click');
    for (let i = 0; i < 3; i += 1) framed.doc.dispatchEvent(new framed.win.Event('scroll'));
    await tick(60);
    expect(sentOf(framed, 'rect')).toEqual([{ stet: 'rect', rect: expect.objectContaining({ height: 20 }), channel: 'c1' }]);
  });

  it('passes a press inside the element under edit through untouched, and lets no click or double click there reach the page (D37)', async () => {
    const framed = await frame('<button id="btn">Start free trial</button>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    const counts = { click: 0, dblclick: 0, mousedown: 0 };
    for (const type of ['click', 'dblclick', 'mousedown'] as const) btn.addEventListener(type, () => (counts[type] += 1));
    await editOn(framed, btn, BUTTON, 'lab_button');
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
    const picks = sentOf(framed, 'pick').length;
    expect(press(framed, btn, 'mousedown')).toBe(true);
    expect(press(framed, btn, 'click')).toBe(false);
    expect(press(framed, btn, 'dblclick')).toBe(false);
    await tick();
    expect(counts).toEqual({ click: 0, dblclick: 0, mousedown: 1 });
    expect(sentOf(framed, 'pick')).toHaveLength(picks);
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
  });

  it('D37: a click inside a summary or a link under edit opens nothing and goes nowhere', async () => {
    const framed = await frame(
      '<details id="faq"><summary id="sum">Questions and answers</summary><p>Hidden answer text</p></details>',
    );
    const summary = framed.doc.getElementById('sum') as HTMLElement;
    await editOn(framed, summary, [{ key: 'lab_summary', texts: ['Questions and answers'] }], 'lab_summary');
    press(framed, summary, 'click');
    expect((framed.doc.getElementById('faq') as HTMLElement).hasAttribute('open')).toBe(false);
    expect(summary.getAttribute('contenteditable')).toBe('plaintext-only');
    closeFrames();

    const runs = await frame('<p id="p" data-stet="k_link">Go to <a id="lk" href="#moved">the pricing guide</a> now.</p>');
    await editOn(runs, runs.doc.getElementById('p') as HTMLElement, [{ key: 'k_link', texts: ['Go to <1>the pricing guide</1> now.'] }], 'k_link', { form: 'runs' });
    const island = runs.doc.querySelector('#lk [data-stet-island]') as HTMLElement;
    expect(island).not.toBeNull();
    expect(press(runs, island, 'click')).toBe(false);
    expect(runs.win.location.hash).toBe('');
    expect(runs.doc.querySelectorAll('[data-stet-island]')).toHaveLength(3);
  });
});

describe('the in-place edit (6.4)', () => {
  async function buttonEdit(body = '<button id="btn">Start free trial</button><p id="other" tabindex="-1">Other words</p>') {
    const framed = await frame(body);
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    const node = btn.firstChild as Text;
    await editOn(framed, btn, BUTTON, 'lab_button');
    return { framed, btn, node };
  }
  const typedValues = (framed: Framed): unknown[] => sentOf(framed, 'typed').map((m) => m['value']);

  it('starts with the element’s whole text selected', async () => {
    const { framed, btn } = await buttonEdit();
    const range = (framed.win.getSelection() as Selection).getRangeAt(0);
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([btn, 0, btn, btn.childNodes.length]);
    expect(framed.doc.activeElement).toBe(btn);
    expect(btn.getAttribute('spellcheck')).toBe('false');
  });

  it('F1: a label React flips mid-edit ends the edit lost, keeping the last proposal (journey B23)', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, 'now');
    // The page's timer turns the label into Saved.: no keystroke wrote it.
    node.data = 'Saved.';
    await tick();
    expect(typedValues(framed)).toEqual(['Start free trialn', 'Start free trialno', 'Start free trialnow']);
    expect(lastOf(framed, 'edited')).toEqual({
      stet: 'edited',
      key: 'lab_button',
      locale: 'default',
      entry: undefined,
      how: 'lost',
      proposed: true,
      channel: 'c1',
    });
    expect(btn.hasAttribute('contenteditable')).toBe(false);
  });

  it('a keystroke that changes nothing leaves the next page write able to end the edit (journey B23)', async () => {
    for (const [where, inputType] of [['start', 'deleteContentBackward'], ['end', 'deleteContentForward']] as const) {
      const { framed, btn, node } = await buttonEdit();
      caret(framed, node, where === 'start' ? 0 : node.length);
      // Backspace at the start, Delete at the end: a beforeinput, then nothing.
      btn.dispatchEvent(new framed.win.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
      await tick(10);
      node.data = 'Saved.';
      await tick();
      // A later keystroke reaches nothing: the edit has ended.
      await keystroke(framed, btn, () => {
        node.data = 'x' + node.data;
      });
      await tick();
      expect(lastOf(framed, 'edited')).toMatchObject({ how: 'lost', proposed: false });
      expect(typedValues(framed)).toEqual([]);
      closeFrames();
    }
  });

  it('ends the edit, kept, when focus leaves the element (journey B23)', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, '!');
    (framed.doc.getElementById('other') as HTMLElement).focus();
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep', proposed: true });
    expect(btn.hasAttribute('contenteditable')).toBe(false);
  });

  it('F2: a value read from the element is trimmed and its whitespace collapsed', async () => {
    const framed = await frame('<p id="ws"></p>');
    const p = framed.doc.getElementById('ws') as HTMLElement;
    p.append(' ', 'Ship copy without a deploy', ' ');
    const trailing = p.lastChild as Text;
    await editOn(framed, p, [{ key: 'lab_headline', texts: ['Ship copy without a deploy'] }], 'lab_headline');
    caret(framed, trailing, 1);
    await typeAtEnd(framed, p, trailing, 'X');
    expect(typedValues(framed)).toEqual(['Ship copy without a deploy X']);
  });

  it('A: text beside the key’s in one element is never typed in place, and the field takes the edit (journey B23)', async () => {
    const framed = await frame('<p id="long"></p>');
    const p = framed.doc.getElementById('long') as HTMLElement;
    p.append('Every change ships in one step.', ' Questions? Ask us.');
    await censusOf(framed, [{ key: 'lab_long', texts: ['Every change ships in one step.'] }]);
    await setMode(framed, 'edit');
    press(framed, p, 'click');
    framed.send({ stet: 'edit', key: 'lab_long', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    expect((lastOf(framed, 'pick')?.['keys'] as Message[])[0]).toMatchObject({ key: 'lab_long', inplace: false });
    expect(lastOf(framed, 'edited')).toMatchObject({ key: 'lab_long', how: 'lost', proposed: false });
    expect(p.hasAttribute('contenteditable')).toBe(false);
  });

  it('C: a write by the page into the edited text between keystrokes ends the edit lost', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, ' first');
    node.data = 'Agent wrote this guide';
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'lost', proposed: true });
    expect(typedValues(framed).at(-1)).toBe('Start free trial first');
    expect(btn.textContent).toBe('Agent wrote this guide');
  });

  it('D: the element leaving the document ends the edit lost (journey B23)', async () => {
    const framed = await frame('<div id="toggle"><p id="p">Ship copy without a deploy</p></div>');
    const p = framed.doc.getElementById('p') as HTMLElement;
    await editOn(framed, p, [{ key: 'lab_headline', texts: ['Ship copy without a deploy'] }], 'lab_headline');
    const node = p.firstChild as Text;
    caret(framed, node, node.length);
    await typeAtEnd(framed, p, node, ' today');
    const fresh = framed.doc.createElement('p');
    fresh.textContent = 'Ship copy without a deploy';
    p.replaceWith(fresh);
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ key: 'lab_headline', how: 'lost', proposed: true });
    expect(typedValues(framed).at(-1)).toBe('Ship copy without a deploy today');
  });

  it('condition 4: a held node React rewrote keeps React’s text', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, 'x');
    node.data = 'Saved.';
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'lost', proposed: true });
    expect(btn.firstChild).toBe(node);
    expect(btn.textContent).toBe('Saved.');
  });

  it('condition 4: a held node removed since the last input leaves the element as React left it', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, 'x');
    const reacts = framed.doc.createTextNode('Saved.');
    btn.replaceChildren(reacts);
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'lost' });
    expect([...btn.childNodes]).toEqual([reacts]);
    expect(btn.textContent).toBe('Saved.');
  });

  it('proposes nothing while an input method composes, and the composed text once it ends', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    btn.dispatchEvent(new framed.win.CompositionEvent('compositionstart', { bubbles: true }));
    await keystroke(framed, btn, () => (node.data += 'とう'), 'insertCompositionText');
    await tick();
    expect(typedValues(framed)).toEqual([]);
    await keystroke(framed, btn, () => (node.data = node.data.replace('とう', '東京')), 'insertCompositionText');
    btn.dispatchEvent(new framed.win.CompositionEvent('compositionend', { bubbles: true }));
    await tick();
    expect(typedValues(framed)).toEqual(['Start free trial東京']);
  });

  it('keeps on Enter, puts the text back on Esc, and types nothing for Shift+Enter in a one-line key', async () => {
    const one = await buttonEdit();
    expect(key(one.framed, one.btn, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(true);
    expect(one.btn.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(key(one.framed, one.btn, { key: 'Enter' }).defaultPrevented).toBe(true);
    await tick();
    expect(lastOf(one.framed, 'edited')).toMatchObject({ how: 'keep', proposed: false });
    closeFrames();

    const two = await buttonEdit();
    caret(two.framed, two.node, two.node.length);
    await typeAtEnd(two.framed, two.btn, two.node, ' now');
    expect(key(two.framed, two.btn, { key: 'Escape' }).defaultPrevented).toBe(true);
    await tick();
    expect(lastOf(two.framed, 'edited')).toMatchObject({ how: 'cancel', proposed: true });
    expect(two.btn.textContent).toBe('Start free trial');
    expect(sentOf(two.framed, 'key')).toEqual([]);
  });

  it('F1: a space is inserted by the agent, so a button or summary never fires on it', async () => {
    const { framed, btn, node } = await buttonEdit();
    const inserted: unknown[][] = [];
    framed.doc.execCommand = ((...args: unknown[]) => {
      inserted.push(args);
      return true;
    }) as typeof framed.doc.execCommand;
    caret(framed, node, node.length);
    expect(key(framed, btn, { key: ' ' }).defaultPrevented).toBe(true);
    expect(inserted).toEqual([['insertText', false, ' ']]);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(key(framed, btn, { key: ' ', ...modifier }).defaultPrevented).toBe(false);
    }
    expect(inserted).toHaveLength(1);
  });

  it('F3: the element removed in the task that blurs it ends the edit lost, not kept', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, '!');
    // An unmount: focusout fires while the element is still in the document, then the page removes it.
    btn.dispatchEvent(new framed.win.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    btn.remove();
    await tick();
    expect(sentOf(framed, 'edited')).toHaveLength(1);
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'lost', proposed: true });
  });

  it('F3: a focusout from an element that stays ends the edit kept', async () => {
    const { framed, btn } = await buttonEdit();
    btn.dispatchEvent(new framed.win.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
  });

  it('F4: a key pressed while an input method composes is the method’s, and ends nothing', async () => {
    const { framed, btn } = await buttonEdit();
    btn.dispatchEvent(new framed.win.CompositionEvent('compositionstart', { bubbles: true }));
    expect(key(framed, btn, { key: 'Enter', isComposing: true }).defaultPrevented).toBe(false);
    expect(key(framed, btn, { key: 'Escape', keyCode: 229 }).defaultPrevented).toBe(false);
    expect(key(framed, btn, { key: ' ', isComposing: true }).defaultPrevented).toBe(false);
    await tick();
    expect(sentOf(framed, 'edited')).toEqual([]);
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
    btn.dispatchEvent(new framed.win.CompositionEvent('compositionend', { bubbles: true }));
    expect(key(framed, btn, { key: 'Enter' }).defaultPrevented).toBe(true);
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
  });

  it('condition 4: a held node the browser removed and replaced in one keystroke is put back, with its text, on Enter', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await keystroke(framed, btn, () => btn.replaceChildren(framed.doc.createTextNode('Q')));
    await tick();
    expect(typedValues(framed)).toEqual(['Q']);
    key(framed, btn, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep', proposed: true });
    expect([...btn.childNodes]).toEqual([node]);
    expect(btn.textContent).toBe('Start free trial');
  });

  it('an edit for another key ends the open one, kept, and puts its element back before it answers', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, '!');
    framed.send({ stet: 'edit', key: 'other_key', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    expect(sentOf(framed, 'edited').map((m) => [m['key'], m['how'], m['proposed']])).toEqual([
      ['lab_button', 'keep', true],
      ['other_key', 'lost', false],
    ]);
    expect(btn.hasAttribute('contenteditable')).toBe(false);
    expect(btn.textContent).toBe('Start free trial');
  });

  it('the same edit sent again changes nothing: it ends nothing and selects nothing', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, 4);
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    expect(sentOf(framed, 'edited')).toEqual([]);
    const range = (framed.win.getSelection() as Selection).getRangeAt(0);
    expect([range.startContainer, range.startOffset, range.collapsed]).toEqual([node, 4, true]);
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
  });

  it('on a multi-line key Shift+Enter is the browser’s, and the newline stays in the value', async () => {
    const framed = await frame('<p id="m">Welcome to the lab friends</p>');
    const p = framed.doc.getElementById('m') as HTMLElement;
    const node = p.firstChild as Text;
    await editOn(framed, p, [{ key: 'lab_multi', texts: ['Welcome to the lab friends'] }], 'lab_multi', { oneLine: false });
    caret(framed, node, node.length);
    expect(key(framed, p, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false);
    await keystroke(framed, p, () => {
      node.data += '\nmore';
    });
    await tick();
    expect(typedValues(framed)).toEqual(['Welcome to the lab friends\nmore']);
  });

  it('answers no census while an edit is open, and one when it ends', async () => {
    const { framed, btn } = await buttonEdit();
    const before = sentOf(framed, 'census').length;
    framed.send({ stet: 'census', keys: BUTTON });
    await tick();
    expect(sentOf(framed, 'census')).toHaveLength(before);
    key(framed, btn, { key: 'Enter' });
    await tick();
    expect(sentOf(framed, 'census')).toHaveLength(before + 1);
  });

  it('clear ends the open edit, kept, and gives the page’s words back', async () => {
    const { framed, btn, node } = await buttonEdit();
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, '!');
    framed.send({ stet: 'clear' });
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep', proposed: true });
    expect(btn.hasAttribute('contenteditable')).toBe(false);
    expect(btn.textContent).toBe('Start free trial');
  });
});

describe('condition 2 and the layer (6.5)', () => {
  const THREE =
    '<h2 id="a">Pricing plans for teams</h2><p id="b">Talk to our sales team</p><button id="c" aria-label="Close this dialog">×</button>';
  const DRAFTS = [
    { key: 'k_a', texts: ['Pricing plans for teams'], draft: 'Plans' },
    { key: 'k_b', texts: ['Talk to our sales team'], draft: 'Talk to us' },
    { key: 'k_c', texts: ['Close this dialog'], draft: 'Close' },
  ];
  const byId = (framed: Framed, id: string): HTMLElement => framed.doc.getElementById(id) as HTMLElement;

  it('never swaps the draft of the key under edit into the element while it is typed in', async () => {
    const framed = await frame('<button id="btn">Start free trial</button>');
    const btn = byId(framed, 'btn');
    const node = btn.firstChild as Text;
    await editOn(framed, btn, BUTTON, 'lab_button');
    caret(framed, node, node.length);
    for (const ch of ' now') {
      await typeAtEnd(framed, btn, node, ch);
      // The dashboard shows each proposal as the selected key's draft; a layer naming the key changes nothing either.
      const value = lastOf(framed, 'typed')?.['value'];
      framed.send({ stet: 'locate', seq: 1, key: 'lab_button', texts: ['Start free trial'], draft: value, scroll: false });
      framed.send({ stet: 'layer', drafts: [{ key: 'lab_button', texts: ['Start free trial'], draft: value }] });
      await tick();
    }
    expect(sentOf(framed, 'typed')).toHaveLength(4);
    expect(btn.textContent).toBe('Start free trial now');
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(sentOf(framed, 'edited')).toEqual([]);
  });

  it('swaps a layer of three drafts at once, an aria-label among them (F95)', async () => {
    const framed = await frame(THREE);
    framed.send({ stet: 'layer', drafts: DRAFTS });
    await tick();
    expect([byId(framed, 'a').textContent, byId(framed, 'b').textContent, byId(framed, 'c').getAttribute('aria-label')]).toEqual([
      'Plans',
      'Talk to us',
      'Close',
    ]);
  });

  it('shows an attribute draft for the selected key in place on a JavaScript host (F95)', async () => {
    const framed = await frame(THREE);
    const reply = await framed.locate({ key: 'k_c', texts: ['Close this dialog'], draft: 'Close' });
    expect(reply).toMatchObject({ found: 1, draft: 'shown' });
    expect(byId(framed, 'c').getAttribute('aria-label')).toBe('Close');
  });

  it('puts back the last layer’s writes the page left alone, and keeps what the page rewrote', async () => {
    const framed = await frame(THREE);
    framed.send({ stet: 'layer', drafts: DRAFTS });
    await tick();
    expect(byId(framed, 'a').textContent).toBe('Plans');
    // The page re-renders one node and one attribute in place.
    (byId(framed, 'b').firstChild as Text).data = 'Talk to sales';
    byId(framed, 'c').setAttribute('aria-label', 'Dismiss');
    framed.send({ stet: 'layer', drafts: [] });
    await tick();
    expect([byId(framed, 'a').textContent, byId(framed, 'b').textContent, byId(framed, 'c').getAttribute('aria-label')]).toEqual([
      'Pricing plans for teams',
      'Talk to sales',
      'Dismiss',
    ]);
  });

  it('puts back both the layer and the selected key’s swap on clear', async () => {
    const framed = await frame(THREE);
    framed.send({ stet: 'layer', drafts: DRAFTS.slice(1) });
    await framed.locate({ key: 'k_a', texts: ['Pricing plans for teams'], draft: 'Plans' });
    expect([byId(framed, 'a').textContent, byId(framed, 'b').textContent, byId(framed, 'c').getAttribute('aria-label')]).toEqual([
      'Plans',
      'Talk to us',
      'Close',
    ]);
    framed.send({ stet: 'clear' });
    await tick();
    expect([byId(framed, 'a').textContent, byId(framed, 'b').textContent, byId(framed, 'c').getAttribute('aria-label')]).toEqual([
      'Pricing plans for teams',
      'Talk to our sales team',
      'Close this dialog',
    ]);
  });
});

describe('the runs form on the html host (6.6)', () => {
  const HEADLINE = '<h1 data-stet="hero">Your site’s words<span class="tail"> in one place.</span></h1><p id="away" tabindex="-1">Away</p>';
  const HERO: CensusKey[] = [{ key: 'hero', texts: ['Your site’s words<1> in one place.</1>'] }];

  async function runsEdit() {
    const framed = await frame(HEADLINE);
    const h1 = framed.doc.querySelector('h1') as HTMLElement;
    const before = h1.innerHTML;
    await editOn(framed, h1, HERO, 'hero', { form: 'runs' });
    const islands = [...h1.querySelectorAll('[data-stet-island]')] as HTMLElement[];
    return { framed, h1, before, islands };
  }

  it('types each run in its own island and sends the value with its tags (journey B23)', async () => {
    const { framed, h1, before, islands } = await runsEdit();
    expect((lastOf(framed, 'pick')?.['keys'] as Message[])[0]).toEqual({ key: 'hero', attr: null, by: 'mark', inplace: true });
    expect(islands.map((island) => [island.getAttribute('contenteditable'), island.textContent])).toEqual([
      ['plaintext-only', 'Your site’s words'],
      ['plaintext-only', ' in one place.'],
    ]);
    const [first, second] = islands.map((island) => island.firstChild as Text) as [Text, Text];
    caret(framed, first, first.length);
    await typeAtEnd(framed, islands[0] as HTMLElement, first, ' (all)');
    caret(framed, second, second.length);
    await typeAtEnd(framed, islands[1] as HTMLElement, second, ' today');
    expect(lastOf(framed, 'typed')?.['value']).toBe('Your site’s words (all)<1> in one place. today</1>');
    key(framed, islands[1] as HTMLElement, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ key: 'hero', how: 'keep', proposed: true });
    expect(h1.innerHTML).toBe(before);
  });

  it('keeps a Backspace at an island’s start and a Delete at its end out of the markup beside it', async () => {
    const { framed, islands } = await runsEdit();
    const [first, second] = islands.map((island) => island.firstChild as Text) as [Text, Text];
    caret(framed, second, 0);
    expect(key(framed, islands[1] as HTMLElement, { key: 'Backspace' }).defaultPrevented).toBe(true);
    caret(framed, first, first.length);
    expect(key(framed, islands[0] as HTMLElement, { key: 'Delete' }).defaultPrevented).toBe(true);
    caret(framed, second, 3);
    expect(key(framed, islands[1] as HTMLElement, { key: 'Backspace' }).defaultPrevented).toBe(false);
    expect((islands[1] as HTMLElement).parentElement?.className).toBe('tail');
  });

  it('keeps the edit open while focus moves from one island to the next', async () => {
    const { framed, h1, islands } = await runsEdit();
    (islands[1] as HTMLElement).focus();
    await tick();
    expect(sentOf(framed, 'edited')).toEqual([]);
    expect(h1.querySelectorAll('[data-stet-island]')).toHaveLength(2);
    (framed.doc.getElementById('away') as HTMLElement).focus();
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
    expect(h1.querySelectorAll('[data-stet-island]')).toHaveLength(0);
  });

  it('F5 (D36): the edit starts in the island under the click, and in the first with text for the Enter key or a click on no run', async () => {
    const RECTS: Record<string, { left: number; right: number }> = { 'Your site’s words': { left: 0, right: 100 }, ' in one place.': { left: 100, right: 200 } };
    const start = async (at: { clientX: number; clientY: number } | null, enter = false) => {
      const framed = await frame(HEADLINE);
      // jsdom lays nothing out: each run's range reports the box its text would have.
      (framed.win.Range.prototype as unknown as { getClientRects: (this: Range) => unknown[] }).getClientRects = function (this: Range) {
        const rect = RECTS[this.commonAncestorContainer.textContent ?? ''];
        return rect === undefined ? [] : [{ ...rect, top: 0, bottom: 20 }];
      };
      const h1 = framed.doc.querySelector('h1') as HTMLElement;
      await censusOf(framed, HERO);
      await setMode(framed, 'edit');
      if (at !== null) press(framed, h1, 'click', at);
      if (enter) key(framed, framed.doc.body, { key: 'Enter' });
      framed.send({ stet: 'edit', key: 'hero', locale: 'default', form: 'runs', oneLine: true });
      await tick();
      const range = (framed.win.getSelection() as Selection).getRangeAt(0);
      const islands = [...h1.querySelectorAll('[data-stet-island]')];
      return islands.indexOf(range.startContainer as Element);
    };
    expect(await start({ clientX: 150, clientY: 10 })).toBe(1);
    expect(await start({ clientX: 50, clientY: 10 })).toBe(0);
    expect(await start({ clientX: 500, clientY: 10 })).toBe(0);
    // The Enter key picks again without a point: the click before it no longer chooses.
    expect(await start({ clientX: 150, clientY: 10 }, true)).toBe(0);
  });

  it('D39: a paragraph hard-wrapped in the page source proposes one spaced line, with no newline or double space', async () => {
    const framed = await frame('<p id="q" data-stet="k_q">\n  Plain static\n  paragraph <a href="#x">with a link</a> inside.\n</p>');
    const p = framed.doc.getElementById('q') as HTMLElement;
    await editOn(framed, p, [{ key: 'k_q', texts: ['Plain static paragraph <1>with a link</1> inside.'] }], 'k_q', { form: 'runs', oneLine: false });
    const first = (p.querySelector('[data-stet-island]') as HTMLElement).firstChild as Text;
    caret(framed, first, first.length);
    await typeAtEnd(framed, p.querySelector('[data-stet-island]') as HTMLElement, first, '!');
    expect(lastOf(framed, 'typed')?.['value']).toBe('Plain static paragraph !<1>with a link</1> inside.');
    // Only the whitespace HTML collapses: a no-break space stays.
    const spaced = await frame('<p id="n" data-stet="k_n">Save\u00a020% <b>today</b></p>');
    const n = spaced.doc.getElementById('n') as HTMLElement;
    await editOn(spaced, n, [{ key: 'k_n', texts: ['Save 20% <1>today</1>'] }], 'k_n', { form: 'runs', oneLine: false });
    const islands = [...n.querySelectorAll('[data-stet-island]')] as HTMLElement[];
    const today = (islands[1] as HTMLElement).firstChild as Text;
    caret(spaced, today, today.length);
    await typeAtEnd(spaced, islands[1] as HTMLElement, today, '!');
    expect(lastOf(spaced, 'typed')?.['value']).toBe('Save\u00a020% <1>today!</1>');
  });
});

describe('following the app (6.7)', () => {
  it('reports the app’s own navigation with its path and query, and the census follows', async () => {
    const framed = await frame('<h1>Plans and pricing</h1>', 'c1', '', AGENT, { url: 'http://127.0.0.1:5173/lab' });
    await censusOf(framed, [{ key: 'k', texts: ['Plans and pricing'] }]);
    const censuses = sentOf(framed, 'census').length;
    framed.win.history.pushState(null, '', '/pricing');
    framed.win.history.replaceState(null, '', '/pricing?tab=2');
    framed.win.history.replaceState(null, '');
    framed.win.history.pushState(null, '', '/pricing?tab=2');
    framed.win.history.go(-2);
    await tick(300);
    expect(sentOf(framed, 'moved')).toEqual([
      { stet: 'moved', how: 'pushState', route: '/pricing', channel: 'c1' },
      { stet: 'moved', how: 'replaceState', route: '/pricing?tab=2', channel: 'c1' },
      { stet: 'moved', how: 'popstate', route: '/lab', channel: 'c1' },
    ]);
    expect(sentOf(framed, 'census').length).toBeGreaterThan(censuses);
    expect(lastOf(framed, 'census')).toMatchObject({ found: { k: 1 } });
  });
});

describe('the frame message boundary (stage 5)', () => {
  it('takes no census, layer, mode, edit or end from another origin, or from the page itself', async () => {
    const framed = await frame('<button id="btn">Start free trial</button>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    for (const [origin, source] of [['http://evil.example', undefined], [DASHBOARD, framed.win]] as const) {
      framed.send({ stet: 'census', keys: BUTTON }, origin, source);
      framed.send({ stet: 'layer', drafts: [{ key: 'lab_button', texts: ['Start free trial'], draft: 'Hacked' }] }, origin, source);
      framed.send({ stet: 'mode', mode: 'edit' }, origin, source);
    }
    await tick();
    press(framed, btn, 'click');
    for (const [origin, source] of [['http://evil.example', undefined], [DASHBOARD, framed.win]] as const) {
      framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true }, origin, source);
    }
    await tick();
    expect(framed.sent.map((m) => m['stet'])).toEqual(['ready']);
    expect(btn.textContent).toBe('Start free trial');
    expect(btn.hasAttribute('contenteditable')).toBe(false);
    // From the dashboard, the same edit starts, and an `end` from elsewhere leaves it open.
    await editOn(framed, btn, BUTTON, 'lab_button');
    framed.send({ stet: 'end', how: 'cancel' }, 'http://evil.example');
    framed.send({ stet: 'end', how: 'cancel' }, DASHBOARD, framed.win);
    await tick();
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(sentOf(framed, 'edited')).toEqual([]);
  });

  it('reads only well-formed messages, and stays working after a malformed one', async () => {
    const framed = await frame('<button id="btn">Start free trial</button><p id="p">Pricing plans for teams</p>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    framed.send({ stet: 'census', keys: [null, 7, { key: 3, texts: [] }, { key: 'k', texts: 'Start free trial' }, { key: 'k2', texts: [1] }] });
    framed.send({ stet: 'census', keys: [{ key: 'lab_button', texts: ['Start free trial'], parts: [{ entry: -1, texts: ['x'] }, { entry: {}, texts: ['y'] }, { entry: 0 }] }] });
    framed.send({ stet: 'layer', drafts: [{ key: 'k', texts: ['Pricing plans for teams'], draft: 5 }, { key: 'k', texts: ['Pricing plans for teams'], draft: 'x', tags: '1' }] });
    framed.send({ stet: 'mode', mode: 'EDIT' });
    framed.send({ stet: 'end', how: 'lost' });
    await tick();
    expect(sentOf(framed, 'census').map((m) => m['found'])).toEqual([{}, { lab_button: 1 }]);
    expect((framed.doc.getElementById('p') as HTMLElement).textContent).toBe('Pricing plans for teams');
    await setMode(framed, 'edit');
    press(framed, btn, 'click');
    for (const bad of [
      { form: 'rich', oneLine: true },
      { form: 'inplace' },
      { form: 'inplace', oneLine: true, entry: { x: 1 } },
      { form: 'inplace', oneLine: true, entry: 1.5 },
      { form: 'inplace', oneLine: true, locale: 7 },
    ]) {
      framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', ...bad });
    }
    await tick();
    expect(btn.hasAttribute('contenteditable')).toBe(false);
    expect(sentOf(framed, 'edited')).toEqual([]);
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    expect(btn.getAttribute('contenteditable')).toBe('plaintext-only');
  });

  it('answers an edit the selected element cannot take as lost and touches nothing', async () => {
    const framed = await frame('<button id="btn">Start free trial</button>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    await censusOf(framed, BUTTON);
    await setMode(framed, 'edit');
    press(framed, btn, 'click');
    framed.send({ stet: 'edit', key: 'other_key', locale: 'default', form: 'inplace', oneLine: true });
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true, entry: 2 });
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'runs', oneLine: true });
    await tick();
    expect(sentOf(framed, 'edited').map((m) => [m['key'], m['how'], m['proposed']])).toEqual([
      ['other_key', 'lost', false],
      ['lab_button', 'lost', false],
      ['lab_button', 'lost', false],
    ]);
    expect(btn.hasAttribute('contenteditable')).toBe(false);
  });

  it('sends the edit’s key, locale and entry with each proposal and its end, and nothing more', async () => {
    const framed = await frame('<ul><li id="li">One file per site</li></ul>');
    const li = framed.doc.getElementById('li') as HTMLElement;
    await editOn(framed, li, [{ key: 'lab_list', texts: [], parts: [{ entry: 1, texts: ['One file per site'] }] }], 'lab_list', { locale: 'fr', entry: 1 });
    const node = li.firstChild as Text;
    caret(framed, node, node.length);
    await typeAtEnd(framed, li, node, '!');
    key(framed, li, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'typed')).toEqual({ stet: 'typed', key: 'lab_list', locale: 'fr', entry: 1, value: 'One file per site!', channel: 'c1' });
    expect(lastOf(framed, 'edited')).toEqual({ stet: 'edited', key: 'lab_list', locale: 'fr', entry: 1, how: 'keep', proposed: true, channel: 'c1' });
  });
});

describe('an edit on an element showing a draft (additions)', () => {
  it('lends the element’s swap to the edit, so a re-locate before the first keystroke writes nothing into it, and shows the newest draft after', async () => {
    const framed = await frame('<button id="btn">Start free trial</button><div id="ticker">0</div>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    await censusOf(framed, BUTTON);
    await framed.locate({ key: 'lab_button', texts: ['Start free trial'], draft: 'Try it free' });
    expect(btn.textContent).toBe('Try it free');
    await setMode(framed, 'edit');
    press(framed, btn, 'click');
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    // The page changes elsewhere: the selected key is located again after its quiet window.
    (framed.doc.getElementById('ticker') as HTMLElement).textContent = '1';
    await tick(300);
    expect(sentOf(framed, 'edited')).toEqual([]);
    expect(btn.textContent).toBe('Try it free');
    const node = btn.firstChild as Text;
    caret(framed, node, node.length);
    await typeAtEnd(framed, btn, node, '!');
    framed.send({ stet: 'locate', seq: 9, key: 'lab_button', texts: ['Start free trial'], draft: 'Try it free!', scroll: false });
    await tick();
    key(framed, btn, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
    expect(btn.textContent).toBe('Try it free!');
    framed.send({ stet: 'clear' });
    await tick();
    expect(btn.textContent).toBe('Start free trial');
  });

  it('hands a node between the selected key’s swap and the layer as the selection moves', async () => {
    const framed = await frame('<h2 id="a">Pricing plans for teams</h2><p id="b">Talk to our sales team</p>');
    const a = framed.doc.getElementById('a') as HTMLElement;
    const b = framed.doc.getElementById('b') as HTMLElement;
    const A = { key: 'k_a', texts: ['Pricing plans for teams'] };
    const B = { key: 'k_b', texts: ['Talk to our sales team'] };
    // k_a selected, k_b in the layer; then k_b selected and k_a in the layer, in either order.
    await framed.locate({ ...A, draft: 'Plans' });
    framed.send({ stet: 'layer', drafts: [{ ...B, draft: 'Talk to us' }] });
    await tick();
    expect([a.textContent, b.textContent]).toEqual(['Plans', 'Talk to us']);
    framed.send({ stet: 'layer', drafts: [{ ...A, draft: 'Plans' }] });
    await framed.locate({ ...B, draft: 'Talk to us' });
    expect([a.textContent, b.textContent]).toEqual(['Plans', 'Talk to us']);
    await framed.locate({ ...A, draft: 'Plans' });
    framed.send({ stet: 'layer', drafts: [{ ...B, draft: 'Talk to us' }] });
    await tick();
    expect([a.textContent, b.textContent]).toEqual(['Plans', 'Talk to us']);
  });

  async function draftedEdit() {
    const framed = await frame('<button id="btn">Start free trial</button>');
    const btn = framed.doc.getElementById('btn') as HTMLElement;
    await censusOf(framed, BUTTON);
    await framed.locate({ key: 'lab_button', texts: ['Start free trial'], draft: 'Try it free' });
    await setMode(framed, 'edit');
    press(framed, btn, 'click');
    framed.send({ stet: 'edit', key: 'lab_button', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    return { framed, btn };
  }

  it('F9: clear while an edit is open sends no located after it, and the page’s words come back', async () => {
    const { framed, btn } = await draftedEdit();
    const before = located(framed).length;
    framed.send({ stet: 'clear' });
    await tick();
    expect(located(framed)).toHaveLength(before);
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
    expect(btn.textContent).toBe('Start free trial');
  });

  it('an edit ending shows the selected key’s draft again without a located of its own', async () => {
    const { framed, btn } = await draftedEdit();
    const before = located(framed).length;
    key(framed, btn, { key: 'Enter' });
    await tick(50);
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
    expect(btn.textContent).toBe('Try it free');
    expect(located(framed)).toHaveLength(before);
  });

  it('gives an edited element back to the layer, so each later layer draft shows there (journey B23)', async () => {
    const framed = await frame('<h1 id="h">Start free trial</h1>');
    const h1 = framed.doc.getElementById('h') as HTMLElement;
    const drafts = (draft: string): Message => ({ stet: 'layer', drafts: [{ key: 'k_h', texts: ['Start free trial'], draft }] });
    await censusOf(framed, [{ key: 'k_h', texts: ['Start free trial'] }]);
    framed.send(drafts('L1'));
    await tick();
    expect(h1.textContent).toBe('L1');
    await setMode(framed, 'edit');
    press(framed, h1, 'click');
    framed.send({ stet: 'edit', key: 'k_h', locale: 'default', form: 'inplace', oneLine: true });
    await tick();
    const node = h1.firstChild as Text;
    caret(framed, node, node.length);
    await typeAtEnd(framed, h1, node, 'Q');
    key(framed, h1, { key: 'Enter' });
    await tick();
    expect(lastOf(framed, 'edited')).toMatchObject({ how: 'keep' });
    for (const draft of ['L2', 'L3']) {
      framed.send(drafts(draft));
      await tick();
      expect(h1.textContent).toBe(draft);
    }
    framed.send({ stet: 'clear' });
    await tick();
    expect(h1.textContent).toBe('Start free trial');
  });
});
