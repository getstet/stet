# Weather sample — stet Flows example (Expo)

A small weather app whose every word is a stet key, built to be drawn as a map
in stet's Flows: three flows (first run, returning, changing units), their
branches and edge states, captured on iOS simulators and an Android emulator.

Expo SDK 57 with Expo Router and the iOS scene lifecycle on. Sign-in is local
and fake; the weather comes from Open-Meteo (free, no key). Standalone: it has
its own `package-lock.json` and installs `@getstet/stet` from npm.

## Run it

```sh
npm install
npx expo start                  # Metro on :8081; press w for the web
npm run ios                     # build and open on the booted iOS simulator (CocoaPods needed)
npm run android                 # build and open on the running emulator (JDK 17 or 21)
npm run storybook               # Storybook on http://127.0.0.1:6007
```

Seeded accounts exist in development builds only, for signing in by hand:
`returning@example.com`, `new@example.com`, `trial-ended@example.com` and
`long-name@example.com`, each with the password `weather-demo`.

## Flows and capture

`stet.flows.json` names every point (a screen in one state), the flows through
them, their branches and the edge states. Each point carries a recipe: the
navigation stack, an account preset and a fixture for the mock API layer.

```sh
node scripts/capture.mjs                                   # every point on every device
node scripts/capture.mjs --device iphone-17e --flow first-run --appearance dark
node scripts/capture.mjs --point home.weather-failed --text-scale 1.3
python3 scripts/overlay.py .stet/captures/home/iphone-17e.json .stet/overlays   # needs Pillow
```

With Metro running and the app open on each device, the script serves the
capture channel on `127.0.0.1:8765` (set `EXPO_PUBLIC_STET_CAPTURE_PORT`, for
example in `.env.local`, to move it; the app and the script both read it). The
app's development helper asks it for the next point, resets the navigation
stack to the point's recipe, waits for the screen to settle and posts the
record; the script takes screenshots until two in a row match. Records and
PNGs land in `.stet/captures/<point>/<device>.json|png`, with `index.json`
listing them all.

On the web dev server a point opens by URL:
`http://localhost:8081/?stet-state=home.weather-failed&appearance=dark&textScale=1.3`.
A parent frame can post `{type: "stet:draft", key, value}`,
`{type: "stet:draft-clear"}` and `{type: "stet:tokens", tokens: {"color.primary": "#1a7f37"}}`.
A link opens a point by hand: `stetweather://stet/state?point=home.offline`.

## Checks

```sh
npx stet check                  # descriptor, snapshot and generated files
npm run check-release           # a release export holds none of the development-only code
sh maestro/walk.sh <udid> <out dir>   # walks the three flows with Maestro
```
