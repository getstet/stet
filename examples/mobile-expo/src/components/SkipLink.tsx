import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

/** Leaves onboarding for Home, which then offers to finish setting up. */
export function SkipLink() {
  const t = useTheme();
  const copy = useCopy();
  return (
    <Pressable
      testID="onboarding-skip"
      accessibilityRole="link"
      hitSlop={8}
      style={{ alignSelf: 'center', padding: t.space.sm }}
      onPress={() => {
        if (router.canDismiss()) router.dismissAll();
        router.replace({ pathname: '/', params: { setup: 'skipped' } });
      }}>
      <Text style={{ color: t.color.primary, fontSize: t.font.size.body, fontWeight: t.font.weight.semibold }}>{copy('onboarding_skip')}</Text>
    </Pressable>
  );
}
