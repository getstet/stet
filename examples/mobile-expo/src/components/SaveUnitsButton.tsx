import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme';

/** The Units screen's own save button, drawn to match the shared one. */
export function SaveUnitsButton({ text, enabled, onPress }: { text: string; enabled: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID="units-save"
      accessibilityRole="button"
      disabled={!enabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: enabled ? t.color.primary : t.color.disabled }]}>
      <Text style={[styles.text, { color: enabled ? t.color.onPrimary : t.color.onDisabled }]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 17, fontWeight: '600' },
});
