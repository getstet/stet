import { router } from 'expo-router';
import { Text } from 'react-native';

import { updateAccount } from '@/auth/session';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { fill, useCopy } from '@/copy';
import { useTheme } from '@/theme';

export default function OnboardingNotifications() {
  const t = useTheme();
  const copy = useCopy();
  const choose = (allowed: boolean) => {
    updateAccount({ notifications: allowed });
    router.push({ pathname: '/onboarding/done', params: { notifications: allowed ? 'allowed' : 'denied' } });
  };
  return (
    <Screen>
      <ScreenHeader back progress={{ step: 3, of: 3 }} eyebrow={fill(copy('onboarding_step'), { step: 3 })} title={copy('notifications_ask_title')} />
      <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{copy('notifications_ask_body')}</Text>
      <PrimaryButton testID="notifications-allow" title={copy('notifications_allow')} onPress={() => choose(true)} />
      <PrimaryButton testID="notifications-deny" title={copy('notifications_deny')} variant="secondary" onPress={() => choose(false)} />
    </Screen>
  );
}
