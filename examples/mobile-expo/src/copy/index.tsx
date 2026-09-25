import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';
import { CopyProvider, useCopy as useStetCopy } from '@getstet/stet/react';
import { useMemo, type ReactNode } from 'react';

import descriptorJson from '../../content/descriptor.json';
import { DEFAULTS } from '../../content/defaults';
import { createStore } from '@/lib/store';

export const descriptor = descriptorJson as unknown as Descriptor;
export const { resolved } = resolveAll(descriptor, readBundle(DEFAULTS));

/** Draft values under preview. Only development tooling writes them. */
export const copyDrafts = createStore<Record<string, string>>({});

export function AppCopyProvider({ children }: { children: ReactNode }) {
  const drafts = copyDrafts.use();
  const values = useMemo(() => (Object.keys(drafts).length ? { ...resolved, ...drafts } : resolved), [drafts]);
  return (
    <CopyProvider descriptor={descriptor} resolved={values}>
      {children}
    </CopyProvider>
  );
}

/**
 * stet's `useCopy`. A development build also notes which component read each
 * key, so the capture helper can tell apart two keys that share a value.
 */
export function useCopy() {
  const copy = useStetCopy();
  return __DEV__ ? (require('@/stet-dev/copy-reads').recordReads(copy) as typeof copy) : copy;
}

/** Puts values into a key's `{{name}}` placeholders. */
export function fill(value: string, vars: Record<string, string | number>): string {
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}
