import { after } from 'next/server';
import { createStetFormsHandler } from '@getstet/stet/server';
__STORE_IMPORT__

import { limitByAddress } from '__LIMIT_MODULE__';

export async function stetForms(method: 'GET' | 'POST' | 'OPTIONS', req: Request): Promise<Response> {
  const store = __STORE__;
  try {
    const forms = createStetFormsHandler({
      store,
      secret: process.env.__SECRET_ENV__ ?? '',
      unsubscribeBase: process.env.STET_FORMS_BASE ?? '',
      guard: limitByAddress,
      honeypot: 'website',
      defer: (run) => after(run),
      // onJoin sends the welcome through your own provider — see "The welcome email" in the stet contacts doc.
    });
    return await forms[method](req);
  } finally {
    __STORE_END__
  }
}
