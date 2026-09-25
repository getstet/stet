import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme';

export type PrimaryButtonProps = {
  title: string;
  variant?: 'primary' | 'secondary' | 'disabled';
  onPress?: () => void;
  testID?: string;
};

/** The app's shared button. `disabled` is drawn greyed and ignores presses. */
export function PrimaryButton({ title, variant = 'primary', onPress, testID }: PrimaryButtonProps) {
  const t = useTheme();
  const disabled = variant === 'disabled';
  const fill = variant === 'primary' ? t.color.primary : variant === 'secondary' ? 'transparent' : t.color.disabled;
  const ink = variant === 'primary' ? t.color.onPrimary : variant === 'secondary' ? t.color.primary : t.color.onDisabled;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: t.size.button,
          borderRadius: t.radius.button,
          backgroundColor: fill,
          borderColor: variant === 'secondary' ? t.color.primary : fill,
          opacity: pressed ? 0.85 : 1,
        },
      ]}>
      <Text numberOfLines={1} style={{ color: ink, fontSize: t.font.size.button, fontWeight: t.font.weight.semibold }}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 12, borderWidth: 2 },
});
