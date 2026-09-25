import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

export default function OnboardingDone() {
  const t = useTheme();
  const copy = useCopy();
  const { notifications } = useLocalSearchParams<{ notifications?: string }>();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: t.space.md }}>
        <Text accessibilityRole="header" style={{ color: t.color.text, fontSize: t.font.size.display, fontWeight: t.font.weight.bold }}>
          {copy('onboarding_done_title')}
        </Text>
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>
          {notifications === 'denied' ? copy('onboarding_done_body_denied') : copy('onboarding_done_body_allowed')}
        </Text>
      </View>
      <PrimaryButton
        testID="onboarding-done"
        title={copy('onboarding_done_cta')}
        onPress={() => {
          if (router.canDismiss()) router.dismissAll();
          router.replace('/');
        }}
      />
    </Screen>
  );
}
