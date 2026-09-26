import path from 'node:path';

import type { StorybookConfig } from '@storybook/react-native-web-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  // Reanimated's worklets need their Babel plugin on the web too, as Metro applies it for the app.
  framework: {
    name: '@storybook/react-native-web-vite',
    options: { pluginReactOptions: { babel: { plugins: ['react-native-worklets/plugin'] } } },
  },
  viteFinal: async (vite) => {
    vite.resolve ??= {};
    vite.resolve.alias = { ...(vite.resolve.alias as object), '@': path.resolve(import.meta.dirname, '../src') };
    // Stories render the components alone: the development-only capture and
    // state handling stay out, as in a release build.
    // `content/defaults` names both the snapshot (.json) and its generated module
    // (.ts); the module is the one the app imports, as Metro resolves it.
    // The `.web` variants lead, as the react-native-web plugin orders them, so a
    // build resolves gesture-handler's web modules rather than its native ones.
    const web = ['.web.mjs', '.web.js', '.web.mts', '.web.ts', '.web.tsx'];
    const extensions = vite.resolve.extensions ?? [...web, '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
    vite.resolve.extensions = [...extensions.filter((e) => e !== '.json'), '.json'];
    vite.define = { ...vite.define, __DEV__: 'false' };
    return vite;
  },
};

export default config;
