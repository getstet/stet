import type { Preview } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { AppCopyProvider } from '../src/copy';
import { useTheme } from '../src/theme';

function Frame({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <View style={{ padding: 24, backgroundColor: t.color.background, maxWidth: 420 }}>{children}</View>;
}

const preview: Preview = {
  decorators: [
    (Story) => (
      <AppCopyProvider>
        <Frame>
          <Story />
        </Frame>
      </AppCopyProvider>
    ),
  ],
};

export default preview;
