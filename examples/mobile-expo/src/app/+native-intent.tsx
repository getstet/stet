// Deep links pass through here. In a development build,
// `stetweather://stet/state?point=<id>` opens a point from stet.flows.json; in
// a release bundle `__DEV__` is false, the branch is dropped and every path
// passes through unchanged.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (__DEV__) {
    const redirected = require('@/stet-dev/state-link').redirectStateLink(path);
    if (redirected) return redirected;
  }
  return path;
}
