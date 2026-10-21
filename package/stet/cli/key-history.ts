/**
 * One key's past values from git, for a snapshot site's History.
 *
 * Git keeps no history per key, so the snapshot's own history is read and each
 * revision's value of the key taken out of it: one `git log --follow` for the
 * commits that touched the snapshot, each with the path the file held there,
 * then one `git cat-file --batch` for every revision's blob. The batch answer
 * is read as it arrives, object by object by the size git states, since a
 * snapshot spans many lines and a value may hold anything; only the parsed
 * value of the key survives each blob, so the total read has no ceiling.
 */

import { canonicalize } from '../src/codegen.js';
import { MAX_OUTPUT } from './email-render.js';
import { gitBytes, gitStream } from './git.js';

export interface KeyVersion {
  commit: string;
  short: string;
  date: string;
  author: string;
  value: unknown;
}

export interface KeyHistory {
  versions: KeyVersion[];
  /** True where a revision's snapshot was too large to parse safely and its version is missing. */
  truncated: boolean;
}

/** The largest single snapshot revision parsed; a bigger one is skipped and the history answers `truncated`. */
export const MAX_BLOB = 64 * 1024 * 1024;

/**
 * The distinct values `key` held in `locale`, newest first, each at the commit
 * that introduced it: walking the snapshot's commits oldest to newest, a
 * version is kept where its canonical value differs from the last kept one. A
 * revision whose snapshot does not parse is skipped; a key it does not hold
 * reads `undefined`. A move of the snapshot file is followed, each revision
 * read at the path it held.
 */
export async function keyHistory(
  cwd: string,
  snapshotPath: string,
  key: string,
  locale: string,
  limit = 1000,
  maxBlob = MAX_BLOB,
): Promise<KeyHistory> {
  const none: KeyHistory = { versions: [], truncated: false };
  // The log is one short record per commit, so `limit` bounds it.
  const log = gitBytes(cwd, ['log', '--follow', '--name-only', '-z', '--format=%x01%H%x09%h%x09%aI%x09%an', '-n', String(limit), '--', snapshotPath], {
    maxBuffer: MAX_OUTPUT,
  });
  if (log.code !== 0) return none;
  const commits = log.stdout
    .toString('utf8')
    .split('\x01')
    .slice(1)
    .map((record) => {
      // `<sha>\t<short>\t<date>\t<author>\0\n<path>\0`, the path root-relative as git names it.
      const [head = '', rest = ''] = record.split('\0');
      const [commit = '', short = '', date = '', ...author] = head.split('\t');
      return { commit, short, date, author: author.join('\t'), path: rest.replace(/^\n/, '') };
    })
    .reverse();
  if (commits.length === 0) return none;
  // A path git did not name, or one a request line cannot carry, is read where the caller said.
  const fallback = `./${snapshotPath.replace(/^\.\//, '')}`;
  const specs = commits.map((c) => `${c.commit}:${c.path === '' || c.path.includes('\n') ? fallback : c.path}\n`);

  const versions: KeyVersion[] = [];
  let truncated = false;
  let last: string | null = null;
  let index = 0;
  const reader = new BatchReader(maxBlob, (blob) => {
    const c = commits[index];
    index += 1;
    if (c === undefined) return;
    if (blob === 'large') {
      truncated = true;
      return;
    }
    if (blob === null) return;
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(blob.toString('utf8'));
    } catch {
      return;
    }
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    const blocks = snapshot as Record<string, unknown>;
    const block = Object.hasOwn(blocks, locale) ? blocks[locale] : undefined;
    const value = block !== null && typeof block === 'object' && Object.hasOwn(block, key) ? (block as Record<string, unknown>)[key] : undefined;
    const canonical = value === undefined ? '' : JSON.stringify(canonicalize(value));
    if (canonical === last) return;
    last = canonical;
    versions.push({ commit: c.commit, short: c.short, date: c.date, author: c.author, value });
  });
  const ok = await new Promise<boolean>((resolve) => {
    const child = gitStream(cwd, ['cat-file', '--batch']);
    child.stdout.on('data', (chunk: Buffer) => reader.push(chunk));
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // The request is written while the answer is read, so neither side waits on the other.
    child.stdin.on('error', () => undefined);
    child.stdin.end(specs.join(''));
  });
  if (!ok) return none;
  return { versions: versions.reverse(), truncated };
}

/**
 * `cat-file --batch`'s answer read as it streams, one callback per request line
 * in order: each object is `<sha> <type> <size>\n<bytes>\n`, its body taken by
 * `<size>` and never by a newline; `<spec> missing\n` (or any other one-line
 * answer, or an object that is not a blob) is null, a body over `maxBlob` is
 * `'large'` and its bytes are dropped as they pass. Holds at most one body.
 */
class BatchReader {
  private head: Buffer[] = [];
  /** Bytes of the current object's body and closing newline still to come; 0 between objects. */
  private remaining = 0;
  private size = 0;
  private kept: Buffer[] | null = null;
  private done: 'blob' | 'large' | 'other' = 'other';

  constructor(
    private readonly maxBlob: number,
    private readonly onObject: (blob: Buffer | 'large' | null) => void,
  ) {}

  push(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      if (this.remaining === 0) {
        const end = chunk.indexOf(0x0a, at);
        if (end === -1) {
          this.head.push(chunk.subarray(at));
          return;
        }
        const line = Buffer.concat([...this.head, chunk.subarray(at, end)]).toString('latin1');
        this.head = [];
        at = end + 1;
        const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(line);
        if (header === null) {
          this.onObject(null);
          continue;
        }
        this.size = Number(header[2]);
        this.remaining = this.size + 1;
        this.done = header[1] !== 'blob' ? 'other' : this.size > this.maxBlob ? 'large' : 'blob';
        this.kept = this.done === 'blob' ? [] : null;
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - at);
      this.kept?.push(chunk.subarray(at, at + take));
      this.remaining -= take;
      at += take;
      if (this.remaining > 0) continue;
      if (this.done === 'blob') this.onObject(Buffer.concat(this.kept ?? []).subarray(0, this.size));
      else this.onObject(this.done === 'large' ? 'large' : null);
      this.kept = null;
    }
  }
}
