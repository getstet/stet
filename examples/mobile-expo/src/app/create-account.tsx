import { router } from 'expo-router';
import { useState } from 'react';

import { createAccount } from '@/auth/session';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { TextField } from '@/components/TextField';
import { useCopy } from '@/copy';

export default function CreateAccount() {
  const copy = useCopy();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle');
  const ready = /.+@.+\..+/.test(email.trim()) && password.length >= 8;
  return (
    <Screen>
      <ScreenHeader back title={copy('create_account_title')} />
      <TextField
        testID="email"
        label={copy('email_label')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />
      <TextField
        testID="password"
        label={copy('password_label')}
        hint={copy('create_account_password_hint')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <PrimaryButton
        testID="create-account-submit"
        title={copy('create_account_submit')}
        variant={ready ? 'primary' : 'disabled'}
        status={status}
        onPress={() => {
          // The account is local; the short wait shows the button's working and done states.
          setStatus('loading');
          setTimeout(() => {
            createAccount(email, password);
            setStatus('success');
          }, 700);
          setTimeout(() => router.replace('/onboarding/name'), 1400);
        }}
      />
    </Screen>
  );
}
