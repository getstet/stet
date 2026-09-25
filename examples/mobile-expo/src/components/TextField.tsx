import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '@/theme';

type Props = Omit<TextInputProps, 'style'> & { label?: string; hint?: string; error?: string };

/** A labelled text input with an optional hint or error under it. */
export function TextField({ label, hint, error, ...input }: Props) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      {label ? <Text style={{ color: t.color.text, fontSize: t.font.size.caption, fontWeight: t.font.weight.semibold }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={t.color.textMuted}
        {...input}
        style={[
          styles.input,
          {
            minHeight: t.size.field,
            borderRadius: t.radius.field,
            borderColor: error ? t.color.danger : t.color.border,
            backgroundColor: t.color.surface,
            color: t.color.text,
            fontSize: t.font.size.body,
          },
        ]}
      />
      {error ? <Text style={{ color: t.color.danger, fontSize: t.font.size.caption }}>{error}</Text> : null}
      {hint && !error ? <Text style={{ color: t.color.textMuted, fontSize: t.font.size.caption }}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, paddingHorizontal: 14 },
});
