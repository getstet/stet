# web-signup

A small Next.js app for stet's Flows map: sign up, welcome, a signed-in
dashboard and settings. Every word it shows is a stet key
(`content/descriptor.json`). Sign-in is local and fake, and the API is a mock
in `lib/api.ts`, so nothing leaves the machine.

It installs `@getstet/stet` from npm and sits outside the package's npm
workspace, with its own lock file.

```sh
npm install
npm run dev              # http://127.0.0.1:3100
npm run capture          # every point on every device → .stet/captures/
npm run check:live       # stet:draft and stet:tokens change the running app
npm run check:release    # next build carries none of the development-only code
npx stet check
```

## Points

`stet.flows.json` lists the app's points (a screen in one state), its two
flows and their branches, and the two devices (desktop 1280×800, mobile
390×844). A development server opens any point directly:

```
http://127.0.0.1:3100/?stet-state=signup.unavailable
http://127.0.0.1:3100/settings?stet-state=settings.unsaved&appearance=dark&textScale=1.2
```

The point's account and fixture (`dev/fixtures.ts`) are loaded, the appearance
and text scale applied, and the route replaced with the point's screen.

## Development only

`dev/dev-root.tsx` holds the state handling, the `stet:draft`,
`stet:draft-clear` and `stet:tokens` message handlers (accepted from the parent
frame only), and the hook the capture script reads. The root layout imports it
behind `process.env.NODE_ENV === 'development'`, so `next build` drops it;
`npm run check:release` proves that.

A `stet:tokens` message carries the token overrides in full, as dot paths
(`{ "color.primary": "#15803D" }`) or nested objects; `{}` restores
`theme/tokens.json`.

## Capture records

`.stet/captures/<pointId>/<deviceId>.json` and `.png`, plus `index.json`
(gitignored). Keys are found by text with the preview agent's matcher, narrowed
to the elements made by a component that read the key. `node
scripts/overlay.mjs <pointId> <deviceId>` draws a record's boxes over its
screenshot.
