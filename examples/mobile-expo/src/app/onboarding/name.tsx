import { router } from 'expo-router';
import { useState } from 'react';

import { updateAccount } from '@/auth/session';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SkipLink } from '@/components/SkipLink';
import { TextField } from '@/components/TextField';
import { fill, useCopy } from '@/copy';

export default function OnboardingName() {
  const copy = useCopy();
  const [name, setName] = useState('');
  return (
    <Screen>
      <ScreenHeader eyebrow={fill(copy('onboarding_step'), { step: 1 })} title={copy('onboarding_name_title')} />
      <TextField testID="name-field" value={name} onChangeText={setName} placeholder={copy('onboarding_name_placeholder')} autoCapitalize="words" />
      <PrimaryButton
        testID="onboarding-continue"
        title={copy('onboarding_continue')}
        variant={name.trim() ? 'primary' : 'disabled'}
        onPress={() => {
          updateAccount({ name: name.trim() });
          router.push('/onboarding/units');
        }}
      />
      <SkipLink />
    </Screen>
  );
}
