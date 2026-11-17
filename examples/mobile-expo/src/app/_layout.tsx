import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppCopyProvider, useCopy } from '@/copy';
import { useTheme } from '@/theme';

// Development builds only: the capture helper, state links, the web state hook
// and the preview messages. `__DEV__` is false in a release bundle, so the
// minifier drops this branch and the require with it.
const StetDev: React.ComponentType | null = __DEV__ ? require('@/stet-dev').StetDev : null;

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppCopyProvider>
        <AppStack />
        {StetDev ? <StetDev /> : null}
      </AppCopyProvider>
    </GestureHandlerRootView>
  );
}

function AppStack() {
  const t = useTheme();
  const copy = useCopy();
  return (
    <>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          title: copy('app_name'),
          contentStyle: { backgroundColor: t.color.background },
        }}
      />
    </>
  );
}
