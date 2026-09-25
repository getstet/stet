import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { signIn } from '@/auth/session';
import { Screen } from '@/components/Screen';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SignInButton } from '@/components/SignInButton';
import { TextField } from '@/components/TextField';
import { useCopy } from '@/copy';

export default function SignIn() {
  const copy = useCopy();
  const params = useLocalSearchParams<{ error?: string }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Screen>
      <ScreenHeader back title={copy('sign_in_title')} />
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
        value={password}
        onChangeText={(value) => {
          setPassword(value);
          if (params.error) router.setParams({ error: undefined });
        }}
        secureTextEntry
        error={params.error === 'wrong-password' ? copy('sign_in_error') : undefined}
      />
      <SignInButton
        label={copy('sign_in_submit')}
        onPress={() => {
          if (!signIn(email, password)) return router.setParams({ error: 'wrong-password' });
          if (router.canDismiss()) router.dismissAll();
          router.replace('/');
        }}
      />
    </Screen>
  );
}
