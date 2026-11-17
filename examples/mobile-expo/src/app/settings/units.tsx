import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { updateAccount, useAccount, type Units } from '@/auth/session';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SaveUnitsButton } from '@/components/SaveUnitsButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { UnitsPicker } from '@/components/UnitsPicker';
import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

/**
 * The unsaved choice, the saved confirmation and the leave prompt live in the
 * route's params, so each state of this screen has its own address.
 */
export default function UnitsSettings() {
  const t = useTheme();
  const copy = useCopy();
  const account = useAccount();
  const params = useLocalSearchParams<{ draft?: Units; saved?: string; confirm?: string }>();
  if (!account) return <Redirect href="/welcome" />;
  const draft = params.draft ?? account.units;
  const dirty = draft !== account.units;
  const save = () => updateAccount({ units: draft });

  return (
    <Screen
      overlay={
        params.confirm === 'leave' && dirty ? (
          <ConfirmDialog
            title={copy('unsaved_changes_title')}
            body={copy('unsaved_changes_body')}
            confirm={{
              title: copy('unsaved_changes_save'),
              onPress: () => {
                save();
                router.back();
              },
            }}
            cancel={{ title: copy('unsaved_changes_discard'), onPress: () => router.back() }}
          />
        ) : null
      }>
      <ScreenHeader back={() => (dirty ? router.setParams({ confirm: 'leave' }) : router.back())} title={copy('settings_units_title')} />
      <Text style={{ color: t.color.textMuted, fontSize: t.font.size.body }}>{copy('settings_units_body')}</Text>
      <UnitsPicker value={draft} onChange={(units) => router.setParams({ draft: units, saved: undefined })} />
      <SaveUnitsButton
        text={copy('units_save_label')}
        enabled={dirty}
        onPress={() => {
          save();
          router.setParams({ draft: undefined, saved: '1' });
        }}
      />
      {params.saved === '1' && !dirty ? (
        <Text testID="units-saved" style={{ color: t.color.text, fontSize: t.font.size.body }}>
          {copy('settings_units_saved')}
        </Text>
      ) : null}
    </Screen>
  );
}
