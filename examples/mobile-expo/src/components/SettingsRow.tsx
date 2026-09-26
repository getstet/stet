import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme';

import { Toggle } from './Toggle';

type Props = {
  label: string;
  value?: string;
  onPress?: () => void;
  toggle?: { on: boolean; onChange: (on: boolean) => void };
  testID?: string;
};

/** A row in a settings list: a label and either a value with a chevron or a switch. A switch row toggles anywhere it is pressed. */
export function SettingsRow({ label, value, onPress, toggle, testID }: Props) {
  const t = useTheme();
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const press = toggle ? () => toggle.onChange(!toggle.on) : onPress;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={toggle ? 'switch' : 'button'}
      accessibilityState={toggle ? { checked: toggle.on } : undefined}
      disabled={!press}
      onPress={press}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.row, { paddingVertical: t.space.md, borderBottomColor: t.color.border }]}>
      <Text style={[styles.label, { color: t.color.text, fontSize: t.font.size.body }]}>{label}</Text>
      {value ? <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{value}</Text> : null}
      {toggle ? (
        <Toggle on={toggle.on} pressed={pressed} focused={focused} />
      ) : (
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.heading }}>›</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { flex: 1 },
});
