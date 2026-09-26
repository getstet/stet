import type { Preview } from '@storybook/react-native-web-vite';
import { useLayoutEffect } from 'react';
import { View } from 'react-native';

import { AppCopyProvider } from '../src/copy';
import { themeOverrides, useTheme, type ComponentState } from '../src/theme';

function Frame({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ padding: 24, backgroundColor: t.color.background, maxWidth: 420 }}>{children}</View>;
}

/** A story's `parameters.states` forces component states, as the dashboard's sandbox does. */
function ForcedStates({ states, children }: { states?: Record<string, ComponentState>; children: React.ReactNode }) {
  const key = JSON.stringify(states ?? {});
  useLayoutEffect(() => {
    themeOverrides.set((o) => ({ ...o, states: states ?? {} }));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return children;
}

const preview: Preview = {
  decorators: [
    (Story, context) => (
      <AppCopyProvider>
        <ForcedStates states={context.parameters.states}>
          <Frame>
            <Story />
          </Frame>
        </ForcedStates>
      </AppCopyProvider>
    ),
  ],
};

export default preview;
