import { Pressable, StyleSheet, Switch, Text } from 'react-native';

import { useTheme } from '@/theme';

type Props = {
  label: string;
  value?: string;
  onPress?: () => void;
  toggle?: { on: boolean; onChange: (on: boolean) => void };
  testID?: string;
};

/** A row in a settings list: a label and either a value with a chevron or a switch. */
export function SettingsRow({ label, value, onPress, toggle, testID }: Props) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={toggle ? 'switch' : 'button'}
      disabled={!onPress}
      onPress={onPress}
      style={[styles.row, { paddingVertical: t.space.md, borderBottomColor: t.color.border }]}>
      <Text style={[styles.label, { color: t.color.text, fontSize: t.font.size.body }]}>{label}</Text>
      {value ? <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{value}</Text> : null}
      {toggle ? (
        <Switch value={toggle.on} onValueChange={toggle.onChange} trackColor={{ true: t.color.primary }} />
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
