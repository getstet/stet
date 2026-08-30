// Every check in this package runs offline from committed files. The guard is
// structural, not a convention: a test that reaches the network fails loudly
// instead of quietly proving the wrong thing.
import http from 'node:http';
import https from 'node:https';

const offline = (what: string) =>
  (): never => {
    throw new Error(
      `offline guard: ${what} was called during a test. stet's core takes parsed data and returns data — nothing in src/ may open a connection, and no check may depend on one.`,
    );
  };

globalThis.fetch = offline('fetch') as unknown as typeof globalThis.fetch;
http.request = offline('http.request') as unknown as typeof http.request;
http.get = offline('http.get') as unknown as typeof http.get;
https.request = offline('https.request') as unknown as typeof https.request;
https.get = offline('https.get') as unknown as typeof https.get;
