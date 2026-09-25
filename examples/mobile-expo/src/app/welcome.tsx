import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

export default function Welcome() {
  const t = useTheme();
  const copy = useCopy();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: t.space.md }}>
        <Text accessibilityRole="header" style={{ color: t.color.text, fontSize: t.font.size.display, fontWeight: t.font.weight.bold }}>
          {copy('welcome_title')}
        </Text>
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{copy('welcome_body')}</Text>
      </View>
      <View style={{ gap: t.space.sm }}>
        <PrimaryButton testID="welcome-create-account" title={copy('welcome_create_account')} onPress={() => router.push('/create-account')} />
        <PrimaryButton testID="welcome-sign-in" title={copy('welcome_sign_in')} variant="secondary" onPress={() => router.push('/sign-in')} />
      </View>
    </Screen>
  );
}
