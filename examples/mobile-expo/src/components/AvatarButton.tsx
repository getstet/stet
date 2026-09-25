import { Pressable, Text } from 'react-native';

import { useTheme } from '@/theme';

/** The signed-in person's initial in a circle. */
export function AvatarButton({ name, label, onPress }: { name: string; label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID="profile-button"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.color.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: t.color.primary, fontSize: 18, fontWeight: t.font.weight.bold }}>{(name.trim()[0] ?? '·').toUpperCase()}</Text>
    </Pressable>
  );
}
