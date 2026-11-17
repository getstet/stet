import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import type { Units } from '@/auth/session';
import { useCopy } from '@/copy';
import { useTokens, type Spring } from '@/theme';
import { fade, move, useMotionMode } from '@/theme/motion';
import { useComponentState, useReplay } from '@/theme/state';

export type UnitsPickerTokens = {
  height: number;
  radius: number;
  padding: number;
  track: { background: string; border: { rest: string; focused: string } };
  indicator: { background: string; radius: number; spring: Spring };
  label: { fontSize: number; fontWeight: TextStyle['fontWeight']; rest: string; selected: string; duration: number };
  press: { opacity: number };
};

const UNITS: Units[] = ['celsius', 'fahrenheit'];

/** Celsius or Fahrenheit, as a two-part control whose highlight slides to the choice. */
export function UnitsPicker({ value, onChange }: { value: Units; onChange: (units: Units) => void }) {
  const k = useTokens<UnitsPickerTokens>('unitsPicker');
  const copy = useCopy();
  const mode = useMotionMode();
  const [pressed, setPressed] = useState<Units | null>(null);
  const [focused, setFocused] = useState(false);
  const [replayed, setReplayed] = useState<Units | null>(null);
  const state = useComponentState('UnitsPicker', { pressed: pressed != null, focused });
  const shown = replayed ?? value;
  const labels: Record<Units, string> = { celsius: copy('units_celsius_label'), fahrenheit: copy('units_fahrenheit_label') };

  const width = useSharedValue(0);
  const at = useSharedValue(UNITS.indexOf(shown));
  useEffect(() => {
    at.value = move(UNITS.indexOf(shown), k.indicator.spring, mode);
  }, [shown, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps

  useReplay('UnitsPicker', {
    select: () => {
      const other = UNITS.find((u) => u !== value) as Units;
      setTimeout(() => setReplayed(other), 60);
      setTimeout(() => setReplayed(null), 1100);
    },
  });

  const indicator = useAnimatedStyle(() => {
    // The track's 1-point border and its padding surround the options.
    const segment = Math.max(0, width.value - 2 * (k.padding + 1)) / UNITS.length;
    return { width: segment, transform: [{ translateX: at.value * segment }] };
  });

  // A forced `pressed` shows on the option not chosen: the one a press would pick.
  const pressedOn = state === 'pressed' ? (pressed ?? (UNITS.find((u) => u !== shown) as Units)) : null;
  return (
    <View
      accessibilityRole="radiogroup"
      onLayout={(e) => {
        width.value = e.nativeEvent.layout.width;
      }}
      style={[
        styles.track,
        {
          minHeight: k.height,
          borderRadius: k.radius,
          padding: k.padding,
          backgroundColor: k.track.background,
          borderColor: state === 'focused' ? k.track.border.focused : k.track.border.rest,
        },
      ]}>
      <Animated.View
        style={[styles.indicator, { top: k.padding, bottom: k.padding, left: k.padding, borderRadius: k.indicator.radius, backgroundColor: k.indicator.background }, indicator]}
      />
      {UNITS.map((units) => (
        <Option
          key={units}
          units={units}
          label={labels[units]}
          selected={units === shown}
          pressed={units === pressedOn}
          tokens={k}
          onPress={() => onChange(units)}
          onPressed={(on) => setPressed(on ? units : null)}
          onFocused={setFocused}
        />
      ))}
    </View>
  );
}

function Option({
  units,
  label,
  selected,
  pressed,
  tokens: k,
  onPress,
  onPressed,
  onFocused,
}: {
  units: Units;
  label: string;
  selected: boolean;
  pressed: boolean;
  tokens: UnitsPickerTokens;
  onPress: () => void;
  onPressed: (on: boolean) => void;
  onFocused: (on: boolean) => void;
}) {
  const mode = useMotionMode();
  const ink = selected ? k.label.selected : k.label.rest;
  const color = useSharedValue(ink);
  const opacity = useSharedValue(1);
  useEffect(() => {
    color.value = fade(ink, k.label.duration, mode);
    opacity.value = fade(pressed ? k.press.opacity : 1, k.label.duration, mode);
  }, [ink, pressed, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = useAnimatedStyle(() => ({ color: color.value, opacity: opacity.value }));
  return (
    <Pressable
      testID={`units-${units}`}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      onPressIn={() => onPressed(true)}
      onPressOut={() => onPressed(false)}
      onFocus={() => onFocused(true)}
      onBlur={() => onFocused(false)}
      style={styles.option}>
      <Animated.Text numberOfLines={1} style={[{ color: ink, fontSize: k.label.fontSize, fontWeight: k.label.fontWeight }, text]}>
        {label}
      </Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderWidth: 1 },
  indicator: { position: 'absolute', pointerEvents: 'none' },
  option: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
});
