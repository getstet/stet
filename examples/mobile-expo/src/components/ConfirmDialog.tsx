import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { useTheme } from '@/theme';

type Props = {
  title: string;
  body: string;
  confirm: { title: string; onPress: () => void };
  cancel: { title: string; onPress: () => void };
};

/** A centred dialog over a dimmed screen, drawn in the app rather than by the OS. */
export function ConfirmDialog({ title, body, confirm, cancel }: Props) {
  const t = useTheme();
  return (
    <View testID="confirm-dialog" style={[styles.scrim, { backgroundColor: t.color.scrim, padding: t.space.lg }]}>
      <View accessibilityRole="alert" style={{ backgroundColor: t.color.background, borderRadius: t.radius.card, padding: t.space.lg, gap: t.space.md }}>
        <Text style={{ color: t.color.text, fontSize: t.font.size.heading, fontWeight: t.font.weight.bold }}>{title}</Text>
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{body}</Text>
        <PrimaryButton testID="dialog-confirm" title={confirm.title} onPress={confirm.onPress} />
        <PrimaryButton testID="dialog-cancel" title={cancel.title} variant="secondary" onPress={cancel.onPress} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'center' },
});
