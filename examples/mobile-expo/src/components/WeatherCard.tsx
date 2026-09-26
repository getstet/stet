import { useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type DimensionValue, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';

import { conditionKey, type WeatherState } from '@/api/weather';
import { PrimaryButton } from '@/components/PrimaryButton';
import { fill, useCopy } from '@/copy';
import { useTheme, useTokens, type Bezier, type MotionMode } from '@/theme';
import { fade, glide, useMotionMode } from '@/theme/motion';
import { useComponentState, useReplay } from '@/theme/state';

import { glyphOf, WeatherGlyph, type WeatherGlyphTokens } from './WeatherGlyph';

export type WeatherCardTokens = {
  background: string;
  radius: number;
  padding: number;
  gap: number;
  temperature: { fontSize: number; fontWeight: TextStyle['fontWeight']; color: string; countDuration: number };
  entrance: { rise: number; duration: number; easing: Bezier; stagger: number };
  glyph: WeatherGlyphTokens;
  skeleton: { base: string; shimmer: string; period: number };
};

/** Today's weather for one city, or why it isn't there. */
export function WeatherCard({ state, onRetry }: { state: WeatherState; onRetry: () => void }) {
  const t = useTheme();
  const k = useTokens<WeatherCardTokens>('weatherCard');
  const copy = useCopy();
  const forced = useComponentState('WeatherCard', { loading: state.status === 'loading', error: state.status === 'failed' });
  // Each new state, and each replay, runs the entrance again.
  const [run, setRun] = useState(0);
  useReplay('WeatherCard', { entrance: () => setRun((n) => n + 1) });

  const card = { backgroundColor: k.background, borderRadius: k.radius, padding: k.padding, gap: k.gap };
  const heading = { color: t.color.text, fontSize: t.font.size.heading, fontWeight: t.font.weight.bold };
  const body = { color: t.color.textMuted, fontSize: t.font.size.body };
  const shown = forced === 'loading' ? 'loading' : forced === 'error' ? 'failed' : state.status;

  if (shown === 'loading') {
    return (
      <View testID="weather-card-loading" style={card}>
        <Text style={body}>{copy('weather_loading')}</Text>
        <Skeleton tokens={k} />
      </View>
    );
  }
  if (shown === 'failed') {
    return (
      <View testID="weather-card-failed" style={card} key={`failed-${run}`}>
        <Rise index={0} tokens={k}>
          <Text style={heading}>{copy('weather_error_title')}</Text>
        </Rise>
        <Rise index={1} tokens={k}>
          <Text style={body}>{copy('weather_error_body')}</Text>
        </Rise>
        <Rise index={2} tokens={k}>
          <PrimaryButton title={copy('weather_retry_label')} onPress={onRetry} />
        </Rise>
      </View>
    );
  }
  if (state.status === 'not-found') {
    return (
      <View testID="weather-card-not-found" style={card} key={`not-found-${run}`}>
        <Rise index={0} tokens={k}>
          <Text style={heading}>{fill(copy('city_not_found_title'), { city: state.query })}</Text>
        </Rise>
        <Rise index={1} tokens={k}>
          <Text style={body}>{copy('city_not_found_body')}</Text>
        </Rise>
      </View>
    );
  }
  if (state.status !== 'loaded') return null;
  const w = state.weather;
  const condition = conditionKey(w.code);
  return (
    <View testID="weather-card-loaded" style={card} key={`loaded-${run}`}>
      <Rise index={0} tokens={k}>
        <View style={styles.row}>
          <Text style={[body, styles.condition]}>{fill(copy('weather_now_label'), { city: w.city })}</Text>
          <WeatherGlyph glyph={glyphOf(condition)} />
        </View>
      </Rise>
      <Rise index={1} tokens={k}>
        <View style={styles.row}>
          <CountUp to={w.temperature} tokens={k} />
          <Text style={[heading, styles.condition]}>{copy(condition)}</Text>
        </View>
      </Rise>
      <Rise index={2} tokens={k}>
        <Text style={body}>{fill(copy('weather_high_low'), { high: w.high, low: w.low })}</Text>
      </Rise>
    </View>
  );
}

/** Fades in and rises into place, after the children before it. Reduced motion only fades. */
function Rise({ index, tokens: k, children }: { index: number; tokens: WeatherCardTokens; children: ReactNode }) {
  const mode = useMotionMode();
  const [initial] = useState(() => (mode === 'still' ? 1 : 0));
  const shown = useSharedValue(initial);
  const lift = useSharedValue(mode === 'full' ? k.entrance.rise : 0);
  useEffect(() => {
    const delay = mode === 'full' ? index * k.entrance.stagger : 0;
    shown.value = withDelay(delay, fade(1, k.entrance.duration, mode));
    lift.value = withDelay(delay, glide(0, k.entrance.duration, k.entrance.easing, mode));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const style = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ translateY: lift.value }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** The temperature, counting up to its value as the card arrives. */
function CountUp({ to, tokens: k }: { to: number; tokens: WeatherCardTokens }) {
  const mode = useMotionMode();
  const [value, setValue] = useState(mode === 'full' ? 0 : to);
  useEffect(() => {
    if (mode !== 'full') return setValue(to);
    const started = Date.now();
    const delay = k.entrance.stagger;
    let frame = 0;
    const tick = () => {
      const p = Math.min(1, Math.max(0, (Date.now() - started - delay) / k.temperature.countDuration));
      setValue(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, mode, k.temperature.countDuration, k.entrance.stagger]);
  return (
    <Text style={{ color: k.temperature.color, fontSize: k.temperature.fontSize, fontWeight: k.temperature.fontWeight, fontVariant: ['tabular-nums'] }}>
      {value}°
    </Text>
  );
}

/** Placeholder bars with a highlight sweeping across them while the weather loads. */
function Skeleton({ tokens: k }: { tokens: WeatherCardTokens }) {
  const mode = useMotionMode();
  const sweep = useSharedValue(0);
  useEffect(() => {
    if (mode !== 'full') {
      cancelAnimation(sweep);
      sweep.value = 0;
      return;
    }
    sweep.value = withRepeat(withTiming(1, { duration: k.skeleton.period, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }), -1);
    return () => cancelAnimation(sweep);
  }, [mode, k.skeleton.period]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Bar width="60%" height={14} tokens={k} sweep={sweep} mode={mode} />
      <Bar width={120} height={64} radius={12} tokens={k} sweep={sweep} mode={mode} />
      <Bar width="40%" height={14} tokens={k} sweep={sweep} mode={mode} />
    </>
  );
}

function Bar({ width, height, radius, tokens: k, sweep, mode }: { width: DimensionValue; height: number; radius?: number; tokens: WeatherCardTokens; sweep: SharedValue<number>; mode: MotionMode }) {
  const measured = useSharedValue(0);
  const band = useAnimatedStyle(() => {
    const w = measured.value;
    const b = Math.max(40, w * 0.6);
    return { width: b, opacity: mode === 'full' ? 1 : 0, transform: [{ translateX: -b + sweep.value * (w + b) }] };
  });
  // The web build takes the CSS property; native takes React Native's own.
  const gradient = `linear-gradient(90deg, transparent, ${k.skeleton.shimmer}, transparent)`;
  const highlight = (Platform.OS === 'web' ? { backgroundImage: gradient } : { experimental_backgroundImage: gradient }) as ViewStyle;
  return (
    <View
      onLayout={(e) => {
        measured.value = e.nativeEvent.layout.width;
      }}
      style={[styles.bar, { width, height, borderRadius: radius ?? height / 2, backgroundColor: k.skeleton.base }]}>
      <Animated.View style={[styles.band, highlight, band]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  condition: { flex: 1, minWidth: 0 },
  bar: { overflow: 'hidden' },
  band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});
