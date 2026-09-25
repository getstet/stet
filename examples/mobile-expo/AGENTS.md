# Weather sample (stet example, Expo)

An Expo SDK 57 app for stet's Flows: every user-facing word is a stet key, and
development builds carry the capture helper that `scripts/capture.mjs` drives.

- Routes live in `src/app/` (Expo Router); components in `src/components/`.
- Copy: `useCopy()` from `@/copy` (stet's `useCopy`, plus the development-only
  read recorder). Add or change words through `content/descriptor.json` and
  `content/defaults.json`, then `npx stet upgrade && npx stet pull && npx stet check`.
- Styling: `theme/tokens.json`, read through `useTheme()` from `@/theme`.
- Development-only code sits behind `__DEV__` (`src/stet-dev/`, `src/api/mock/`);
  `npm run check-release` proves none of it reaches a release bundle.
- `ios/` and `android/` are generated (`npx expo prebuild`); never edit them.

<!-- stet:agent-guidance:begin -->
Copy in this project is managed by stet — `content/descriptor.json` names the keys. Never hardcode user-facing copy; route copy work through the stet CLI (run `stet` for the commands), not source edits.
<!-- stet:agent-guidance:end -->
