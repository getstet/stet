import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';

import { useTokens } from '@/theme';
import { useMotionMode } from '@/theme/motion';

export type Glyph = 'clear' | 'partlyCloudy' | 'cloudy' | 'rain' | 'snow' | 'storm';

export type WeatherGlyphTokens = {
  size: number;
  sun: string;
  cloud: string;
  rain: string;
  snow: string;
  bolt: string;
  spinPeriod: number;
  fallPeriod: number;
};

/** A condition key's picture: sun, clouds, rain, snow or a storm. */
export function glyphOf(condition: string): Glyph {
  if (condition.endsWith('_clear')) return 'clear';
  if (condition.endsWith('_partly_cloudy')) return 'partlyCloudy';
  if (/_(drizzle|rain|showers)$/.test(condition)) return 'rain';
  if (condition.endsWith('_snow')) return 'snow';
  if (condition.endsWith('_storm')) return 'storm';
  return 'cloudy';
}

/** A looping 0 → 1 clock, stopped when motion is reduced or still. */
function useLoop(period: number) {
  const mode = useMotionMode();
  const t = useSharedValue(0);
  useEffect(() => {
    if (mode !== 'full') {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: period, easing: Easing.linear, reduceMotion: ReduceMotion.Never }), -1);
    return () => cancelAnimation(t);
  }, [mode, period]); // eslint-disable-line react-hooks/exhaustive-deps
  return t;
}

/** Drawn from views: the condition's shapes, moving slowly while motion is on. */
export function WeatherGlyph({ glyph }: { glyph: Glyph }) {
  const k = useTokens<{ glyph: WeatherGlyphTokens }>('weatherCard').glyph;
  const s = k.size;
  const spin = useLoop(k.spinPeriod);
  const fall = useLoop(glyph === 'snow' ? k.fallPeriod * 1.8 : k.fallPeriod);
  const drift = useLoop(k.fallPeriod * 4);
  const cloudDrift = useAnimatedStyle(() => ({ transform: [{ translateX: Math.sin(drift.value * Math.PI * 2) * s * 0.03 }] }));

  const cloud = (scale: number, left: number, top: number) => (
    <Animated.View style={[styles.abs, { left: left * s, top: top * s, width: s * 0.8 * scale, height: s * 0.5 * scale }, cloudDrift]}>
      <View style={[styles.abs, { left: 0.1 * s * scale, top: 0.12 * s * scale, width: 0.34 * s * scale, height: 0.34 * s * scale, borderRadius: s, backgroundColor: k.cloud }]} />
      <View style={[styles.abs, { left: 0.3 * s * scale, top: 0, width: 0.42 * s * scale, height: 0.42 * s * scale, borderRadius: s, backgroundColor: k.cloud }]} />
      <View style={[styles.abs, { left: 0, bottom: 0, width: 0.8 * s * scale, height: 0.24 * s * scale, borderRadius: s, backgroundColor: k.cloud }]} />
    </Animated.View>
  );

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: s, height: s }}>
      {glyph === 'clear' ? <Sun size={s} center={s / 2} scale={1} color={k.sun} spin={spin} /> : null}
      {glyph === 'partlyCloudy' ? (
        <>
          <Sun size={s} center={s * 0.36} scale={0.7} color={k.sun} spin={spin} />
          {cloud(0.85, 0.28, 0.44)}
        </>
      ) : null}
      {glyph === 'cloudy' ? cloud(1.1, 0.06, 0.24) : null}
      {glyph === 'rain' || glyph === 'snow' || glyph === 'storm' ? cloud(1, 0.1, 0.08) : null}
      {glyph === 'rain' || glyph === 'snow'
        ? [0, 1, 2].map((i) => <Drop key={i} index={i} size={s} snow={glyph === 'snow'} color={glyph === 'snow' ? k.snow : k.rain} fall={fall} />)
        : null}
      {glyph === 'storm' ? <Bolt size={s} color={k.bolt} flash={fall} /> : null}
    </View>
  );
}

function Sun({ size: s, center, scale, color, spin }: { size: number; center: number; scale: number; color: string; spin: SharedValue<number> }) {
  const d = s * 0.4 * scale;
  const rays = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));
  const box = s * scale;
  return (
    <>
      <Animated.View style={[styles.abs, { left: center - box / 2, top: center - box / 2, width: box, height: box }, rays]}>
        {Array.from({ length: 8 }, (_, i) => (
          <View
            key={i}
            style={[
              styles.abs,
              {
                left: box / 2 - s * 0.04 * scale,
                top: 0,
                width: s * 0.08 * scale,
                height: s * 0.15 * scale,
                borderRadius: s,
                backgroundColor: color,
                transformOrigin: ['50%', box / 2, 0],
                transform: [{ rotate: `${i * 45}deg` }],
              },
            ]}
          />
        ))}
      </Animated.View>
      <View style={[styles.abs, { left: center - d / 2, top: center - d / 2, width: d, height: d, borderRadius: d, backgroundColor: color }]} />
    </>
  );
}

function Drop({ index, size: s, snow, color, fall }: { index: number; size: number; snow: boolean; color: string; fall: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const p = (fall.value + index / 3) % 1;
    return { opacity: p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85, transform: [{ translateY: p * s * 0.3 }, { rotate: snow ? '0deg' : '15deg' }] };
  });
  const w = snow ? s * 0.09 : s * 0.06;
  const h = snow ? s * 0.09 : s * 0.16;
  return <Animated.View style={[styles.abs, { left: s * (0.28 + index * 0.2), top: s * 0.56, width: w, height: h, borderRadius: s, backgroundColor: color }, style]} />;
}

function Bolt({ size: s, color, flash }: { size: number; color: string; flash: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ opacity: flash.value > 0.82 && flash.value < 0.9 ? 0.35 : 1 }));
  const bar = { width: s * 0.08, height: s * 0.22, backgroundColor: color, borderRadius: s * 0.02 };
  return (
    <Animated.View style={[styles.abs, { left: s * 0.42, top: s * 0.5, width: s * 0.2, height: s * 0.46 }, style]}>
      <View style={[styles.abs, bar, { left: s * 0.07, top: 0, transform: [{ rotate: '20deg' }] }]} />
      <View style={[styles.abs, { left: s * 0.02, top: s * 0.19, width: s * 0.16, height: s * 0.06, backgroundColor: color, borderRadius: s * 0.02 }]} />
      <View style={[styles.abs, bar, { left: s * 0.07, top: s * 0.22, transform: [{ rotate: '20deg' }] }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
});
