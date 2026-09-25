import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

/** A screen's frame: the safe area, the background and a scrolling column. */
export function Screen({ children, overlay }: { children: ReactNode; overlay?: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={['top', 'bottom']} style={[styles.fill, { backgroundColor: t.color.background }]}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.column, { padding: t.space.lg, gap: t.space.md }]}
        keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {overlay ? <View style={StyleSheet.absoluteFill}>{overlay}</View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  column: { flexGrow: 1 },
});
