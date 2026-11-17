import { router } from 'expo-router';
import { useState } from 'react';

import { session, updateAccount, type Units } from '@/auth/session';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SkipLink } from '@/components/SkipLink';
import { UnitsPicker } from '@/components/UnitsPicker';
import { fill, useCopy } from '@/copy';

export default function OnboardingUnits() {
  const copy = useCopy();
  const [units, setUnits] = useState<Units>(session.get()?.units ?? 'celsius');
  return (
    <Screen>
      <ScreenHeader back progress={{ step: 2, of: 3 }} eyebrow={fill(copy('onboarding_step'), { step: 2 })} title={copy('onboarding_units_title')} />
      <UnitsPicker value={units} onChange={setUnits} />
      <PrimaryButton
        testID="onboarding-continue"
        title={copy('onboarding_continue')}
        onPress={() => {
          updateAccount({ units });
          router.push('/onboarding/notifications');
        }}
      />
      <SkipLink />
    </Screen>
  );
}
