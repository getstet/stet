import { Redirect, router } from 'expo-router';
import { Text, View } from 'react-native';

import { signOut, trialDaysLeft, useAccount } from '@/auth/session';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SettingsRow } from '@/components/SettingsRow';
import { fill, useCopy } from '@/copy';
import { useTheme } from '@/theme';

export default function Profile() {
  const t = useTheme();
  const copy = useCopy();
  const account = useAccount();
  if (!account) return <Redirect href="/welcome" />;
  const days = trialDaysLeft(account);
  return (
    <Screen>
      <ScreenHeader back title={copy('profile_title')} />
      <View style={{ gap: t.space.xs }}>
        <Text testID="profile-name" numberOfLines={1} style={{ color: t.color.text, fontSize: t.font.size.heading, fontWeight: t.font.weight.bold }}>
          {account.name}
        </Text>
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{account.email}</Text>
        <Text testID="profile-plan" style={{ color: days ? t.color.textMuted : t.color.danger, fontSize: t.font.size.body }}>
          {days ? fill(copy('profile_plan_trial'), { days }) : copy('profile_plan_ended')}
        </Text>
      </View>
      <SettingsRow testID="profile-settings" label={copy('profile_settings_link')} onPress={() => router.push('/settings')} />
      <PrimaryButton
        testID="sign-out"
        title={copy('profile_sign_out')}
        variant="secondary"
        onPress={() => {
          signOut();
          if (router.canDismiss()) router.dismissAll();
          router.replace('/welcome');
        }}
      />
    </Screen>
  );
}
