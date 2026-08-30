/**
 * The snapshot adapter: a project with no database at all. `read` returns zero
 * rows — not null, not an error — so resolution serves every key from the
 * committed snapshot through the identical fallback path and reports
 * `source: 'snapshot'`.
 *
 * The write half is honestly missing rather than faked: every method answers
 * `NotSupported`, and a surface reading it renders the project read-only.
 * Publish is a commit here, and there is no drafts file.
 */

import type { StoreRow } from '../src/resolve.js';
import type { ChangesetOps, NotSupported, StoreAdapter } from '../src/store.js';

export function createSnapshotStore(opts: { project: string }): StoreAdapter {
  return {
    project: opts.project,
    canApplyDDL: false,
    // The capability answers rather than being absent, exactly like the write
    // half: a surface reads `NotSupported` and renders the grouping affordance
    // honestly disabled, and nothing pretends a change was opened.
    changesets: {
      async open(): Promise<NotSupported> {
        return notSupported('changesets.open');
      },
      async list(): Promise<NotSupported> {
        return notSupported('changesets.list');
      },
      async get(): Promise<NotSupported> {
        return notSupported('changesets.get');
      },
      async schedule(): Promise<NotSupported> {
        return notSupported('changesets.schedule');
      },
      async publishChange(): Promise<NotSupported> {
        return notSupported('changesets.publishChange');
      },
      async abandon(): Promise<NotSupported> {
        return notSupported('changesets.abandon');
      },
      async discardDraft(): Promise<NotSupported> {
        return notSupported('changesets.discardDraft');
      },
      async markReverted(): Promise<NotSupported> {
        return notSupported('changesets.markReverted');
      },
    } satisfies ChangesetOps,
    async read(): Promise<StoreRow[]> {
      return [];
    },
    async saveDraft(): Promise<NotSupported> {
      return notSupported('saveDraft');
    },
    async publish(): Promise<NotSupported> {
      return notSupported('publish');
    },
    async revert(): Promise<NotSupported> {
      return notSupported('revert');
    },
    async rename(): Promise<NotSupported> {
      return notSupported('rename');
    },
    async history(): Promise<NotSupported> {
      return notSupported('history');
    },
    async recent(): Promise<NotSupported> {
      return notSupported('recent');
    },
  };
}

function notSupported(method: string): NotSupported {
  return { notSupported: true, method };
}
