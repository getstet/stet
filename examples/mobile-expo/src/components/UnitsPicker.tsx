import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Units } from '@/auth/session';
import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

/** Celsius or Fahrenheit, as two radio rows. */
export function UnitsPicker({ value, onChange }: { value: Units; onChange: (units: Units) => void }) {
  const t = useTheme();
  const copy = useCopy();
  const options: { units: Units; label: string }[] = [
    { units: 'celsius', label: copy('units_celsius_label') },
    { units: 'fahrenheit', label: copy('units_fahrenheit_label') },
  ];
  return (
    <View accessibilityRole="radiogroup" style={[styles.group, { borderColor: t.color.border, borderRadius: t.radius.card }]}>
      {options.map((option, i) => {
        const selected = option.units === value;
        return (
          <Pressable
            key={option.units}
            testID={`units-${option.units}`}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.units)}
            style={[styles.row, { padding: t.space.md }, i > 0 && { borderTopWidth: 1, borderTopColor: t.color.border }]}>
            <Text style={{ flex: 1, color: t.color.text, fontSize: t.font.size.body }}>{option.label}</Text>
            <View style={[styles.radio, { borderColor: selected ? t.color.primary : t.color.border }]}>
              {selected ? <View style={[styles.dot, { backgroundColor: t.color.primary }]} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
