import { Pressable, Text } from 'react-native';

import { useTheme } from '@/theme';

/** Written by hand for the Sign in screen before PrimaryButton existed. */
export function SignInButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID="sign-in-submit"
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: 52,
        borderRadius: 12,
        backgroundColor: t.color.primary,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
      }}>
      <Text style={{ color: '#ffffff', fontSize: 17, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
