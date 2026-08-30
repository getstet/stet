/**
 * `cli/agents.ts` — the agent-guidance block. The cases are enumerated from the
 * emitter's own branches rather than from a description of them: one per
 * `guidanceFiles` targeting outcome, one per `planGuidance` state (including
 * every shape that must read as `differs`), and one per `removeGuidance`
 * position, with the append/remove round trip asserting the host's bytes back
 * exactly.
 *
 * The load-bearing guards here — the unchanged branch, the malformed-marker
 * refusal, the LINE anchor, and the removal loop — are mutation-tested: each is
 * named in the test that fails when it is deleted.
 */
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GUIDANCE_BEGIN,
  GUIDANCE_END,
  applyGuidance,
  buildGuidanceBlock,
  guidanceFiles,
  guidanceSpans,
  hasGuidanceMarker,
  planGuidance,
  planGuidanceRemoval,
  removeGuidance,
} from '../cli/agents.js';
import { defaultConfig, defaultStoreBlock } from '../cli/config.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'stet-agents-'));
}

const BLOCK = buildGuidanceBlock(defaultConfig());

/** A block whose body is host-edited — the shape the differs refusal exists for. */
const EDITED = `${GUIDANCE_BEGIN}\nour own house rules for copy.\n${GUIDANCE_END}\n`;

describe('buildGuidanceBlock', () => {
  it('is the two-line reminder, marker-delimited, with the descriptor path its one interpolation', () => {
    const config = defaultConfig();
    config.descriptorPath = 'content/descriptor.json';
    const block = buildGuidanceBlock(config);
    expect(block.startsWith(`${GUIDANCE_BEGIN}\n`)).toBe(true);
    expect(block.endsWith(`${GUIDANCE_END}\n`)).toBe(true);
    expect(block).toContain('content/descriptor.json');
    expect(block).toContain('managed by stet');
    expect(block).toContain('stet CLI');
    // A reminder, not a manual: three lines, and the middle one is the whole of it.
    expect(block.split('\n')).toHaveLength(4); // two markers, one body line, the terminator
  });

  it('varies with descriptorPath and with nothing else', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    b.descriptorPath = 'copy/keys.json';
    // Everything else that could tempt a variant is moved, and the block ignores it.
    b.store = defaultStoreBlock('pg');
    b.emailSurfaces = ['lib/email/**/*.ts'];
    const [textA, textB] = [buildGuidanceBlock(a), buildGuidanceBlock(b)];
    expect(textA).not.toBe(textB);
    expect(textA.replace('content/descriptor.json', 'copy/keys.json')).toBe(textB);
  });

  it('is deterministic — the same config builds byte-identical text', () => {
    expect(buildGuidanceBlock(defaultConfig())).toBe(buildGuidanceBlock(defaultConfig()));
  });
});

describe('guidanceFiles', () => {
  it('yields BOTH names, identical targets, where the host carries neither', () => {
    const dir = project();
    expect(guidanceFiles(dir)).toEqual([
      { path: join(dir, 'AGENTS.md'), exists: false },
      { path: join(dir, 'CLAUDE.md'), exists: false },
    ]);
  });

  it('yields only the names the host already carries', () => {
    const dir = project();
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n', 'utf8');
    expect(guidanceFiles(dir)).toEqual([{ path: join(dir, 'CLAUDE.md'), exists: true }]);
  });

  it('dedupes a symlinked pair to one plan, keeping the first name', () => {
    const dir = project();
    writeFileSync(join(dir, 'AGENTS.md'), '# House rules\n', 'utf8');
    symlinkSync(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'));
    // Two names, one inode: planned twice, the append would land twice.
    expect(guidanceFiles(dir)).toEqual([{ path: join(dir, 'AGENTS.md'), exists: true }]);
  });

  it('dedupes a HARDLINKED pair — one file, one plan, one append', () => {
    const dir = project();
    writeFileSync(join(dir, 'AGENTS.md'), '# House rules\n', 'utf8');
    // A hardlink has its OWN realpath, so only a dev:ino identity folds it.
    linkSync(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'));
    expect(guidanceFiles(dir)).toEqual([{ path: join(dir, 'AGENTS.md'), exists: true }]);
    // and the append lands exactly once in the one file both names reach
    const plan = planGuidance(join(dir, 'AGENTS.md'), BLOCK);
    applyGuidance(join(dir, 'AGENTS.md'), BLOCK, plan);
    expect(guidanceSpans(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'))).toHaveLength(1);
  });

  it('a DIRECTORY at one name does not suppress the other name being created', () => {
    const dir = project();
    mkdirSync(join(dir, 'CLAUDE.md'));
    // The directory is still listed, so its refusal reaches the report — but it
    // is not an agent-instruction file, so AGENTS.md is still created. Without
    // this the host gets no guidance anywhere and no line saying why.
    expect(guidanceFiles(dir)).toEqual([
      { path: join(dir, 'AGENTS.md'), exists: false },
      { path: join(dir, 'CLAUDE.md'), exists: true },
    ]);
  });

  it('treats a DANGLING symlink as present — existsSync would call it absent and write its target', () => {
    const dir = project();
    symlinkSync(join(dir, 'nowhere.md'), join(dir, 'AGENTS.md'));
    const files = guidanceFiles(dir);
    expect(files).toEqual([{ path: join(dir, 'AGENTS.md'), exists: true }]);
    // The pair default must NOT fire: a create through the link writes nowhere.md.
    expect(files.map((f) => f.path)).not.toContain(join(dir, 'CLAUDE.md'));
  });
});

describe('planGuidance', () => {
  it('write — nothing is at the path', () => {
    const dir = project();
    expect(planGuidance(join(dir, 'AGENTS.md'), BLOCK)).toEqual({ status: 'write' });
  });

  it('append — the file exists and carries no markers', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, '# House rules\n\nBe kind.\n', 'utf8');
    expect(planGuidance(path, BLOCK)).toEqual({ status: 'append' });
  });

  it('unchanged — the span equals the block (the guard that makes a re-run a no-op)', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `# House rules\n\n${BLOCK}`, 'utf8');
    expect(planGuidance(path, BLOCK)).toEqual({ status: 'unchanged' });
  });

  it('unchanged on a CRLF host — a CRLF span must not read as edited forever', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `# House rules\r\n\r\n${BLOCK.split('\n').join('\r\n')}`, 'utf8');
    expect(planGuidance(path, BLOCK).status).toBe('unchanged');
  });

  it('differs — the span was edited by hand, and both remedies are named', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `# House rules\n\n${EDITED}`, 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('differs from what stet would write');
    expect(plan.note).toContain('delete the block and re-run, or keep your edit');
  });

  it('differs — malformed markers: an END that never arrives (the absent-END guard)', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `# House rules\n${GUIDANCE_BEGIN}\nhalf a block\n`, 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('malformed');
  });

  it('differs — malformed markers: an END BEFORE the BEGIN', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `${GUIDANCE_END}\nhost text\n${GUIDANCE_BEGIN}\n`, 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    // Named, not merely refused: a bare status assertion here would pass on any
    // of the four differs branches and discriminate nothing.
    expect(plan.note).toContain('malformed');
  });

  it('unchanged — an END line ending in a bare CR is still the block', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `# House rules\n\n${BLOCK.slice(0, -1)}\r`, 'utf8');
    expect(planGuidance(path, BLOCK).status).toBe('unchanged');
  });

  it('differs — two blocks in one file', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `${BLOCK}\nhost text\n\n${BLOCK}`, 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('more than one');
  });

  it('a marker quoted in host prose or indented is NOT a boundary (the LINE anchor)', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    // Mid-line and indented occurrences both. A substring match would find a
    // BEGIN here, refuse the ordinary host, and — on removal — take the prose
    // between this line and the real block with it.
    const host =
      '# House rules\n' +
      `We mark it with \`${GUIDANCE_BEGIN}\` at the top of the file.\n` +
      '\n' +
      `    ${GUIDANCE_BEGIN}\n` +
      '\n' +
      'Host paragraph that must survive.\n';
    writeFileSync(path, host, 'utf8');
    expect(planGuidance(path, BLOCK)).toEqual({ status: 'append' });
    expect(hasGuidanceMarker(host)).toBe(false);
    // And with a REAL block below them, the span starts at the real one — the
    // quoted lines and the prose between are untouched by the removal.
    const withBlock = `${host}\n${BLOCK}`;
    expect(planGuidance(pathWith(dir, 'MIXED.md', withBlock), BLOCK).status).toBe('unchanged');
    expect(removeGuidance(withBlock)).toBe(host);
  });

  it('a marker inside a FENCED code block is documentation, not a boundary', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    // What a host README that documents stet looks like. Treating the fenced
    // markers as a span would refuse this host on init AND delete these
    // documentation lines on eject — the host-prose-deletion class again.
    const host =
      '# Docs\n' +
      '\n' +
      'Here is the block stet writes:\n' +
      '\n' +
      '```\n' +
      `${GUIDANCE_BEGIN}\n` +
      'Copy in this project is managed by stet.\n' +
      `${GUIDANCE_END}\n` +
      '```\n' +
      '\n' +
      'Host paragraph that must survive.\n';
    writeFileSync(path, host, 'utf8');
    expect(hasGuidanceMarker(host)).toBe(false);
    expect(planGuidance(path, BLOCK)).toEqual({ status: 'append' });
    expect(removeGuidance(host)).toBe(host);
  });

  it('a tilde fence counts too, and a REAL block below one is still found', () => {
    const fenced = `# Docs\n\n~~~markdown\n${GUIDANCE_BEGIN}\nan example\n${GUIDANCE_END}\n~~~\n`;
    expect(hasGuidanceMarker(fenced)).toBe(false);
    // The fence closes, so the block after it is stet's own and is seen.
    const withReal = `${fenced}\n${BLOCK}`;
    expect(guidanceSpans(withReal)).toEqual([BLOCK]);
    expect(removeGuidance(withReal)).toBe(fenced);
  });

  it('differs — a file ending inside an UNCLOSED fence, which has no bottom to append to', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    // The fence never closes, so everything after it — including anything stet
    // appends — is swallowed. Appending here would land the block inside the
    // fence, invisible to the next scan, and append it again on every run.
    const host = '# Docs\n\n```\nnot closed\n';
    writeFileSync(path, host, 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('unclosed code fence');
    // Nothing written, and no second block is reachable by re-running.
    applyGuidance(path, BLOCK, plan);
    expect(readFileSync(path, 'utf8')).toBe(host);
    expect(planGuidance(path, BLOCK).status).toBe('differs');
  });

  it('differs — an info-string line does not CLOSE a fence, so it is still open at EOF', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    // ```js opens; a second ```js does not close (a closer carries no info
    // string), so the file ends fenced-open just the same.
    writeFileSync(path, '# Docs\n\n```js\nconst a = 1;\n```js\n', 'utf8');
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('unclosed code fence');
  });

  it('a block hidden by an unclosed fence is a REMOVAL skip, never a silent no-op', () => {
    // What the append used to produce before the fence was surfaced: a block
    // stet cannot see. eject must say so rather than leave it instructing
    // agents toward a dependency it just removed.
    const orphaned = `# Docs\n\n\`\`\`\n${BLOCK}`;
    expect(hasGuidanceMarker(orphaned)).toBe(false); // invisible to the span walk
    expect(removeGuidance(orphaned)).toBe(orphaned); // and untouched by it
    const plan = planGuidanceRemoval(pathWith(project(), 'CLAUDE.md', orphaned), BLOCK);
    expect(plan.status).toBe('skip');
    expect(plan.status === 'skip' && plan.note).toContain('unclosed code fence');
  });

  it('an unclosed fence with NO marker behind it is absent, not a false removal claim', () => {
    const plan = planGuidanceRemoval(pathWith(project(), 'CLAUDE.md', '# Docs\n\n```\nopen\n'), BLOCK);
    expect(plan.status).toBe('absent');
  });

  it('differs — a dangling symlink, named, never written through', () => {
    const dir = project();
    const path = join(dir, 'AGENTS.md');
    symlinkSync(join(dir, 'nowhere.md'), path);
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('symlink to a missing target');
  });

  it('differs — a DIRECTORY at the path, named as one rather than offered the block remedies', () => {
    const dir = project();
    const path = join(dir, 'AGENTS.md');
    mkdirSync(path);
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('directory');
    expect(plan.note).not.toContain('delete the block and re-run');
    // A bare finding, no tail of its own: each caller phrases the consequence,
    // so `agents install` does not print "was skipped. Nothing was written".
    expect(plan.note).not.toContain('skipped');
  });

  it('differs — a symlink LOOP is named as one, not as a missing target', () => {
    const dir = project();
    const path = join(dir, 'AGENTS.md');
    // Two links pointing at each other: present to lstat, ELOOP to any read.
    symlinkSync(join(dir, 'CLAUDE.md'), path);
    symlinkSync(path, join(dir, 'CLAUDE.md'));
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('differs');
    expect(plan.note).toContain('loop');
    expect(plan.note).not.toContain('missing target');
  });

  it('a LIVE symlink is present and written through — the host chose that layout', () => {
    const dir = project();
    const shared = join(dir, 'shared.md');
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(shared, '# Shared rules\n', 'utf8');
    symlinkSync(shared, path);
    const plan = planGuidance(path, BLOCK);
    expect(plan.status).toBe('append');
    applyGuidance(path, BLOCK, plan);
    // the target gained the block, and the link is still a link
    expect(readFileSync(shared, 'utf8')).toBe(`# Shared rules\n\n${BLOCK}`);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });
});

describe('applyGuidance', () => {
  it('creates the file with the block alone', () => {
    const dir = project();
    const path = join(dir, 'AGENTS.md');
    applyGuidance(path, BLOCK, planGuidance(path, BLOCK));
    expect(readFileSync(path, 'utf8')).toBe(BLOCK);
  });

  it('appends with the host bytes untouched above it', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    const host = '# House rules\n\nBe kind.\n';
    writeFileSync(path, host, 'utf8');
    applyGuidance(path, BLOCK, planGuidance(path, BLOCK));
    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(host)).toBe(true);
    expect(after).toBe(`${host}\n${BLOCK}`);
  });

  it('matches the host file dominant EOL rather than mixing endings into it', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, '# House rules\r\n\r\nBe kind.\r\n', 'utf8');
    applyGuidance(path, BLOCK, planGuidance(path, BLOCK));
    const after = readFileSync(path, 'utf8');
    expect(after).toContain(`${GUIDANCE_BEGIN}\r\n`);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n'); // no bare LF anywhere
    // and it still reads as unchanged on the next run
    expect(planGuidance(path, BLOCK).status).toBe('unchanged');
  });

  // The string cases can never catch this class: a utf8 read of a non-utf8 file
  // already holds U+FFFD where the host's bytes were, so a string compare of
  // read-then-written text agrees with itself while the file on disk has been
  // destroyed. Only a BYTE compare sees it.
  describe('a host file that is not utf8', () => {
    const hosts: Array<[string, Buffer]> = [
      // `# Café\n` in windows-1252 — 0xE9 is not valid utf8 and decodes to U+FFFD.
      ['windows-1252', Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a])],
      // With its BOM, as an editor writes one: 0xFF 0xFE is invalid utf8, so
      // the re-encode compare is what catches this one.
      ['UTF-16LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Note\n', 'utf16le')])],
      // WITHOUT the BOM, which is the case the re-encode compare cannot see:
      // UTF-16LE ASCII is accidentally VALID utf8, because its padding bytes
      // decode as U+0000. Only the zero-byte probe catches it, and this fixture
      // is the only thing that makes that half of the guard load-bearing.
      ['UTF-16LE with no BOM', Buffer.from('# Note\n', 'utf16le')],
    ];
    for (const [name, host] of hosts) {
      it(`is refused rather than appended to — ${name}`, () => {
        const dir = project();
        const path = join(dir, 'CLAUDE.md');
        writeFileSync(path, host);
        const plan = planGuidance(path, BLOCK);
        expect(plan.status).toBe('differs');
        expect(plan.note).toContain('not utf8 text');
        // Nothing written, and the file is byte-identical.
        applyGuidance(path, BLOCK, plan);
        expect(readFileSync(path).equals(host)).toBe(true);
      });
    }

    it('would still keep its bytes if the writer ever ran on one', () => {
      // Defence in depth: the plan above refuses, so this path is unreachable
      // through the command — but the writer APPENDS rather than rewriting, and
      // that is what keeps a host's bytes safe if a caller ever hands it one.
      const dir = project();
      const path = join(dir, 'CLAUDE.md');
      const host = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
      writeFileSync(path, host);
      applyGuidance(path, BLOCK, { status: 'append' });
      const after = readFileSync(path);
      expect(after.subarray(0, host.length).equals(host)).toBe(true);
      expect(after.subarray(host.length).toString('utf8')).toBe(`\n${BLOCK}`);
    });

    it('round-trips a multibyte utf8 host byte for byte — valid utf8 is appended to as ever', () => {
      const dir = project();
      const path = join(dir, 'CLAUDE.md');
      const host = Buffer.from('# Café ☕\n\nBe kind.\n', 'utf8');
      writeFileSync(path, host);
      const plan = planGuidance(path, BLOCK);
      expect(plan.status).toBe('append');
      applyGuidance(path, BLOCK, plan);
      const removed = removeGuidance(readFileSync(path, 'utf8'));
      expect(Buffer.from(removed as string, 'utf8').equals(host)).toBe(true);
    });
  });

  it('writes nothing at all on unchanged and on differs', () => {
    const dir = project();
    const path = join(dir, 'CLAUDE.md');
    const held = `# House rules\n\n${EDITED}`;
    writeFileSync(path, held, 'utf8');
    applyGuidance(path, BLOCK, planGuidance(path, BLOCK));
    expect(readFileSync(path, 'utf8')).toBe(held);

    const clean = join(dir, 'AGENTS.md');
    writeFileSync(clean, `# House rules\n\n${BLOCK}`, 'utf8');
    const before = readFileSync(clean, 'utf8');
    applyGuidance(clean, BLOCK, planGuidance(clean, BLOCK));
    expect(readFileSync(clean, 'utf8')).toBe(before);
  });
});

describe('removeGuidance', () => {
  it('takes a mid-file span and leaves every surrounding byte exact', () => {
    const source = `# House rules\n\n${BLOCK}\nBe kind.\n`;
    expect(removeGuidance(source)).toBe('# House rules\n\nBe kind.\n');
  });

  it('takes a span at position 0', () => {
    expect(removeGuidance(`${BLOCK}# House rules\n`)).toBe('# House rules\n');
  });

  it('takes a span at the end of the file', () => {
    expect(removeGuidance(`# House rules\n\n${BLOCK}`)).toBe('# House rules\n');
  });

  it('takes an END-of-file span that was never newline-terminated', () => {
    const truncated = `# House rules\n\n${GUIDANCE_BEGIN}\nreminder\n${GUIDANCE_END}`;
    expect(removeGuidance(truncated)).toBe('# House rules\n');
  });

  it('takes EVERY span — the loop is what makes the claim per file, not per span', () => {
    // Two appends' worth: each span sits behind its own separator newline.
    const source = `# House rules\n\n${BLOCK}Be kind.\n\n${BLOCK}`;
    expect(removeGuidance(source)).toBe('# House rules\nBe kind.\n');
  });

  it('answers null — the caller deletes the file — only where the source WAS the block', () => {
    expect(removeGuidance(BLOCK)).toBeNull();
  });

  it('answers null for a file that is nothing but blocks — never a zero-byte leftover', () => {
    // Its very first byte was already stet's, so there is no host content to
    // keep and eject deletes the file rather than emptying it.
    expect(removeGuidance(`${BLOCK}\n${BLOCK}`)).toBeNull();
  });

  it("keeps a host's own empty file rather than deleting it", () => {
    // What the append leaves on a pre-existing empty file: the separator, then
    // the block. Its non-span byte is the host's, so the file stays.
    expect(removeGuidance(`\n${BLOCK}`)).toBe('');
  });

  it("keeps a host's BOM-only file, BOM intact", () => {
    expect(removeGuidance(`﻿\n${BLOCK}`)).toBe('﻿');
  });

  it('leaves a file with no span alone, byte for byte', () => {
    const host = '# House rules\n\nBe kind.\n';
    expect(removeGuidance(host)).toBe(host);
  });
});

describe('the append/remove round trip', () => {
  // The seam eject's byte-identity claim rests on: whatever the host had, the
  // append plus the removal give it back exactly.
  const hosts: Array<[string, string]> = [
    ['trailing newline', '# House rules\n\nBe kind.\n'],
    ['NO trailing newline', '# House rules\n\nBe kind.'],
    ['CRLF', '# House rules\r\n\r\nBe kind.\r\n'],
    ['empty', ''],
    ['BOM only', '﻿'],
    ['one line, no newline', 'Be kind.'],
    ['trailing blank lines', '# House rules\n\n\n\n'],
    // A last byte of bare `\r` forms an accidental CRLF with the LF separator;
    // taking both back would lose the host's own carriage return.
    ['a bare CR as its last byte', '# A\n# B\r'],
    ['nothing but a bare CR', '\r'],
  ];
  for (const [name, host] of hosts) {
    it(`restores a host file with ${name} to its pre-append bytes`, () => {
      const dir = project();
      const path = join(dir, 'CLAUDE.md');
      writeFileSync(path, host, 'utf8');
      const plan = planGuidance(path, BLOCK);
      expect(plan.status).toBe('append');
      applyGuidance(path, BLOCK, plan);
      const appended = readFileSync(path, 'utf8');
      expect(appended.startsWith(host)).toBe(true);
      expect(planGuidance(path, BLOCK).status).toBe('unchanged');
      expect(removeGuidance(appended)).toBe(host);
    });
  }

  it('a created file round-trips to a deletion', () => {
    const dir = project();
    const path = join(dir, 'AGENTS.md');
    applyGuidance(path, BLOCK, planGuidance(path, BLOCK));
    expect(removeGuidance(readFileSync(path, 'utf8'))).toBeNull();
  });
});

describe('guidanceSpans and hasGuidanceMarker', () => {
  it('normalizes each span to the block form, so a CRLF host reads as unedited', () => {
    const crlf = `# House rules\r\n\r\n${BLOCK.split('\n').join('\r\n')}`;
    expect(guidanceSpans(crlf)).toEqual([BLOCK]);
  });

  it('names every span, so eject can count the lines it is about to remove', () => {
    expect(guidanceSpans(`${BLOCK}\nhost\n\n${EDITED}`)).toEqual([BLOCK, EDITED]);
  });

  it('a NESTED begin is swallowed by the span it sits in, never starting a second', () => {
    // BEGIN … BEGIN … END is ONE span (first BEGIN to the first END after it).
    // The walk must resume past the span's END, not past its start, or the
    // inner BEGIN opens a phantom second span that runs to end-of-file and
    // takes the host's text with it.
    const source = `${GUIDANCE_BEGIN}\nouter\n${GUIDANCE_BEGIN}\ninner\n${GUIDANCE_END}\nhost text\n`;
    expect(guidanceSpans(source)).toHaveLength(1);
    expect(removeGuidance(source)).toBe('host text\n');
  });

  it('finds a lone marker the span walk cannot use — what the eject report is built on', () => {
    expect(hasGuidanceMarker(`# House rules\n${GUIDANCE_BEGIN}\n`)).toBe(true);
    expect(guidanceSpans(`# House rules\n${GUIDANCE_BEGIN}\n`)).toEqual([]);
    expect(hasGuidanceMarker('# House rules\n')).toBe(false);
  });
});

/** A file written under `dir`, for an assertion that needs a path rather than text. */
function pathWith(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}
