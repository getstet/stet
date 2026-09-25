import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CopyProvider } from '@getstet/stet/react';
import { readBundle, resolveAll, type Descriptor } from '@getstet/stet';

import descriptorJson from '../content/descriptor.json';
import { DEFAULTS } from '../content/defaults';
import { copy } from '@/lib/content';
import { THEME_STYLE_ID, baseTokens, themeCss } from '@/lib/theme';
import './globals.css';

const { resolved } = resolveAll(descriptorJson as unknown as Descriptor, readBundle(DEFAULTS));

export function generateMetadata(): Metadata {
  return { title: copy('app_name') };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const descriptor = descriptorJson as unknown as Descriptor;
  let body = <CopyProvider descriptor={descriptor} resolved={resolved}>{children}</CopyProvider>;
  // Development builds only: preview states, live copy drafts and token
  // try-outs for stet's Flows map. A release build drops this branch.
  if (process.env.NODE_ENV === 'development') {
    const { DevRoot } = await import('@/dev/dev-root');
    body = <DevRoot descriptor={descriptor} resolved={resolved}>{children}</DevRoot>;
  }
  return (
    <html lang="en">
      <head>
        <style id={THEME_STYLE_ID} dangerouslySetInnerHTML={{ __html: themeCss(baseTokens) }} />
      </head>
      <body>{body}</body>
    </html>
  );
}
