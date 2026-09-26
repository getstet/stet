// Development builds only: the component sandbox (`src/stet-dev/sandbox.tsx`).
// metro.config.js leaves this file out of production bundles, so a release
// build has no such route.
const SandboxRoute: React.ComponentType | null = __DEV__ ? require('@/stet-dev/sandbox').SandboxRoute : null;

export default function ComponentSandbox() {
  return SandboxRoute ? <SandboxRoute /> : null;
}
