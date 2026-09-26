// Development builds only: the component sandbox, the screen behind the
// `/__stet/component` route (`src/app/__stet/component.tsx`, which Metro leaves
// out of release builds). `?name=PrimaryButton&variant=primary&state=pressed`
// draws one real component alone, centred on the page background, at the width
// the app's screens give it, with the forced state, token overrides and replays
// applied. Every component with a token group is registered here with its
// variants, states and animations.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Platform, Text, useWindowDimensions, View } from 'react-native';

import type { Units } from '@/auth/session';
import { Notice } from '@/components/Notice';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PrimaryButton } from '@/components/PrimaryButton';
import { StepProgress } from '@/components/StepProgress';
import { TextField } from '@/components/TextField';
import { Toggle } from '@/components/Toggle';
import { UnitsPicker } from '@/components/UnitsPicker';
import { WeatherCard } from '@/components/WeatherCard';
import { useCopy } from '@/copy';
import { themeOverrides, useTheme, type ComponentState } from '@/theme';
import { replays } from '@/theme/state';

type Copy = ReturnType<typeof useCopy>;

type Entry = {
  group: string;
  variants: string[];
  states: ComponentState[];
  animations: string[];
  render: (variant: string, state: ComponentState, copy: Copy) => ReactElement;
};

const CODES: Record<string, number> = { clear: 0, partlyCloudy: 2, cloudy: 3, rain: 61, snow: 71, storm: 95 };

function PickerDemo({ initial }: { initial: Units }) {
  const [value, setValue] = useState(initial);
  return <UnitsPicker value={value} onChange={setValue} />;
}

function ToggleDemo({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  return <Toggle on={on} onChange={setOn} />;
}

function FieldDemo({ variant, state, copy }: { variant: string; state: ComponentState; copy: Copy }) {
  const [value, setValue] = useState('');
  return variant === 'floating' ? (
    <TextField label={copy('email_label')} value={value} onChangeText={setValue} error={state === 'error' ? copy('sign_in_error') : undefined} />
  ) : (
    <TextField placeholder={copy('city_search_placeholder')} value={value} onChangeText={setValue} error={state === 'error' ? copy('sign_in_error') : undefined} />
  );
}

export const registry: Record<string, Entry> = {
  PrimaryButton: {
    group: 'primaryButton',
    variants: ['primary', 'secondary', 'disabled'],
    states: ['rest', 'pressed', 'hovered', 'focused', 'loading', 'success'],
    animations: ['press', 'loading', 'success'],
    render: (variant, _, copy) => (
      <PrimaryButton
        variant={variant as 'primary' | 'secondary' | 'disabled'}
        title={copy(variant === 'secondary' ? 'welcome_sign_in' : variant === 'disabled' ? 'onboarding_continue' : 'welcome_create_account')}
        onPress={() => {}}
      />
    ),
  },
  UnitsPicker: {
    group: 'unitsPicker',
    variants: ['celsius', 'fahrenheit'],
    states: ['rest', 'pressed', 'focused'],
    animations: ['select'],
    render: (variant) => <PickerDemo initial={variant === 'fahrenheit' ? 'fahrenheit' : 'celsius'} />,
  },
  WeatherCard: {
    group: 'weatherCard',
    variants: Object.keys(CODES),
    states: ['rest', 'loading', 'error'],
    animations: ['entrance'],
    render: (variant) => (
      <WeatherCard state={{ status: 'loaded', weather: { city: 'Lisbon', temperature: 21, high: 24, low: 15, code: CODES[variant] ?? 0 } }} onRetry={() => {}} />
    ),
  },
  Notice: {
    group: 'notice',
    variants: ['info', 'warning', 'danger'],
    states: ['rest'],
    animations: ['banner-in', 'dismiss', 'spring-back'],
    render: (variant, _, copy) =>
      variant === 'warning' ? (
        <Notice tone="warning" dismissible title={copy('trial_ended_title')} body={copy('trial_ended_body')} action={{ title: copy('trial_ended_cta'), onPress: () => {} }} />
      ) : variant === 'danger' ? (
        <Notice tone="danger" dismissible title={copy('session_expired_title')} body={copy('session_expired_body')} />
      ) : (
        <Notice tone="info" dismissible title={copy('alerts_count_one')} />
      ),
  },
  OfflineBanner: {
    group: 'notice',
    variants: ['default'],
    states: ['rest'],
    animations: ['banner-in', 'dismiss', 'spring-back'],
    render: () => <OfflineBanner onRetry={() => {}} />,
  },
  Toggle: {
    group: 'toggle',
    variants: ['off', 'on'],
    states: ['rest', 'pressed', 'focused'],
    animations: ['toggle'],
    render: (variant) => <ToggleDemo initial={variant === 'on'} />,
  },
  StepProgress: {
    group: 'stepProgress',
    variants: ['step1', 'step2', 'step3'],
    states: ['rest'],
    animations: ['step'],
    render: (variant) => <StepProgress step={Number(variant.slice(4)) || 1} of={3} />,
  },
  TextField: {
    group: 'textField',
    variants: ['plain', 'floating'],
    states: ['rest', 'focused', 'error'],
    animations: ['focus', 'shake'],
    render: (variant, state, copy) => <FieldDemo variant={variant} state={state} copy={copy} />,
  },
};

export type SandboxParams = {
  name: string;
  variant?: string;
  state?: string;
  appearance?: 'light' | 'dark';
  textScale?: number;
  motion?: 'reduced' | 'still';
  width?: number;
  /** Plays one animation shortly after the component appears (for recordings on a device). */
  play?: string;
};

/** The sandbox route's query, checked. */
function sandboxParams(q: Record<string, string | string[] | undefined>): SandboxParams {
  const one = (key: string) => (typeof q[key] === 'string' ? (q[key] as string) : undefined);
  const num = (key: string) => {
    const n = Number(one(key));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const appearance = one('appearance');
  const motion = one('motion');
  return {
    name: one('name') ?? '',
    variant: one('variant'),
    state: one('state'),
    appearance: appearance === 'dark' || appearance === 'light' ? appearance : undefined,
    textScale: num('textScale'),
    motion: motion === 'reduced' || motion === 'still' ? motion : undefined,
    width: num('width'),
    play: one('play'),
  };
}

export function requestReplay(component: string, animation: string): boolean {
  const request = { component, animation, handled: false };
  replays.set(request);
  return request.handled;
}

/** The route's screen. On a device, `stetweather://__stet/component?name=…` opens it. */
export function SandboxRoute() {
  const query = useLocalSearchParams();
  const key = JSON.stringify(query);
  const params = useMemo(() => sandboxParams(query), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Sandbox params={params} />;
}

function Sandbox({ params }: { params: SandboxParams }) {
  const t = useTheme();
  const copy = useCopy();
  const screen = useWindowDimensions();
  const entry = Object.hasOwn(registry, params.name) ? registry[params.name] : null;
  const variant = entry && params.variant && entry.variants.includes(params.variant) ? params.variant : (entry?.variants[0] ?? '');
  const state = entry && params.state && entry.states.includes(params.state as ComponentState) ? (params.state as ComponentState) : null;

  useEffect(() => {
    themeOverrides.set((o) => ({
      ...o,
      appearance: params.appearance,
      textScale: params.textScale,
      motion: params.motion ?? o.motion,
      states: state ? { [params.name]: state } : {},
    }));
    if (Platform.OS === 'web') {
      window.parent?.postMessage({ type: 'stet:sandbox', name: params.name, variant, state: state ?? 'rest', found: Boolean(entry) }, '*');
    }
    if (!params.play) return;
    const timer = setTimeout(() => requestReplay(params.name, params.play as string), 700);
    return () => clearTimeout(timer);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const width = params.width ?? Math.max(0, screen.width - 2 * t.space.lg);
  return (
    <View style={{ flex: 1, backgroundColor: t.color.background, alignItems: 'center', justifyContent: 'center' }}>
      {entry ? (
        <View testID="stet-sandbox" style={{ width }}>
          {entry.render(variant, state ?? 'rest', copy)}
        </View>
      ) : (
        <Text style={{ fontSize: 16, color: '#b42318' }}>Component not found: {params.name}</Text>
      )}
    </View>
  );
}
