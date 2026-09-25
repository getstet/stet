import { Redirect, router } from 'expo-router';

import { updateAccount, useAccount } from '@/auth/session';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SettingsRow } from '@/components/SettingsRow';
import { useCopy } from '@/copy';

export default function Settings() {
  const copy = useCopy();
  const account = useAccount();
  if (!account) return <Redirect href="/welcome" />;
  return (
    <Screen>
      <ScreenHeader back title={copy('settings_title')} />
      <SettingsRow
        testID="settings-units"
        label={copy('settings_units_row')}
        value={copy(account.units === 'celsius' ? 'units_celsius_label' : 'units_fahrenheit_label')}
        onPress={() => router.push('/settings/units')}
      />
      <SettingsRow
        testID="settings-notifications"
        label={copy('notifications_ask_title')}
        toggle={{ on: account.notifications, onChange: (on) => updateAccount({ notifications: on }) }}
      />
    </Screen>
  );
}
