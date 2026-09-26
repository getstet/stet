import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fetchAlerts, useWeather } from '@/api/weather';
import { signOut, trialDaysLeft, updateAccount, useAccount, type Account } from '@/auth/session';
import { AvatarButton } from '@/components/AvatarButton';
import { Notice } from '@/components/Notice';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { WeatherCard } from '@/components/WeatherCard';
import { fill, useCopy } from '@/copy';
import { useTheme } from '@/theme';

export default function Home() {
  const account = useAccount();
  if (!account) return <Redirect href="/welcome" />;
  return <SignedInHome account={account} />;
}

function SignedInHome({ account }: { account: Account }) {
  const t = useTheme();
  const copy = useCopy();
  const params = useLocalSearchParams<{ city?: string; setup?: string }>();
  const city = params.city || account.city;
  const { state, retry } = useWeather(city, account.units);
  const [query, setQuery] = useState('');
  const [alerts, setAlerts] = useState(0);

  useEffect(() => {
    let live = true;
    fetchAlerts(account.alerts).then((count) => live && setAlerts(count));
    return () => {
      live = false;
    };
  }, [account.alerts]);

  // A first search becomes the account's city.
  useEffect(() => {
    if (state.status === 'loaded' && !account.city) updateAccount({ city: state.weather.city });
  }, [state, account.city]);

  const expired = state.status === 'failed' && state.reason === 'unauthorized';
  const offline = state.status === 'failed' && state.reason === 'offline';
  const trialEnded = trialDaysLeft(account) === 0;
  const text = { color: t.color.text, fontSize: t.font.size.body };

  return (
    <Screen>
      <View style={styles.header}>
        <Text testID="home-greeting" numberOfLines={1} style={[styles.greeting, { color: t.color.text, fontSize: t.font.size.title, fontWeight: t.font.weight.bold }]}>
          {account.name ? fill(copy('home_greeting'), { name: account.name }) : copy('home_greeting_anonymous')}
        </Text>
        <AvatarButton name={account.name || account.email} label={copy('home_profile_button_label')} onPress={() => router.push('/profile')} />
      </View>

      {expired ? (
        <Notice
          testID="notice-session"
          tone="danger"
          title={copy('session_expired_title')}
          body={copy('session_expired_body')}
          action={{
            title: copy('session_expired_cta'),
            onPress: () => {
              signOut();
              router.replace('/sign-in');
            },
          }}
        />
      ) : (
        <>
          {offline ? <OfflineBanner onRetry={retry} /> : null}
          {trialEnded ? (
            <Notice
              testID="notice-trial"
              tone="warning"
              title={copy('trial_ended_title')}
              body={copy('trial_ended_body')}
              action={{ title: copy('trial_ended_cta'), onPress: () => router.push('/profile') }}
            />
          ) : null}
          {alerts > 0 ? (
            <Notice testID="notice-alerts" dismissible tone="info" title={alerts === 1 ? copy('alerts_count_one') : fill(copy('alerts_count_many'), { count: alerts })} />
          ) : null}
          {params.setup === 'skipped' ? (
            <Notice
              testID="notice-setup"
              dismissible
              tone="info"
              title={copy('home_setup_title')}
              body={copy('home_setup_body')}
              action={{ title: copy('home_setup_cta'), variant: 'secondary', onPress: () => router.push('/onboarding/name') }}
            />
          ) : null}

          <View style={styles.search}>
            <View style={styles.searchField}>
              <TextField
                testID="city-search"
                value={query}
                onChangeText={setQuery}
                placeholder={copy('city_search_placeholder')}
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={() => query.trim() && router.setParams({ city: query.trim() })}
              />
            </View>
            <PrimaryButton
              testID="city-search-submit"
              title={copy('city_search_submit')}
              variant="secondary"
              onPress={() => query.trim() && router.setParams({ city: query.trim() })}
            />
          </View>

          {city ? (
            <WeatherCard state={state} onRetry={retry} />
          ) : (
            <View testID="home-empty" style={{ gap: t.space.xs }}>
              <Text style={[text, { fontSize: t.font.size.heading, fontWeight: t.font.weight.bold }]}>{copy('home_empty_title')}</Text>
              <Text style={[text, { color: t.color.textMuted }]}>{copy('home_empty_body')}</Text>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  greeting: { flex: 1 },
  search: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  searchField: { flex: 1 },
});
