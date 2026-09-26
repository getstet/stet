import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useTokens, type Bezier, type ComponentState, type Spring } from '@/theme';
import { fade, glide, move, useMotionMode } from '@/theme/motion';
import { deriveState, useComponentState, useReplay, type Live } from '@/theme/state';

type Colors = { background: Partial<Record<ComponentState, string>>; label: Partial<Record<ComponentState, string>>; border: Partial<Record<ComponentState, string>> };

export type PrimaryButtonTokens = {
  minHeight: number;
  radius: number;
  paddingX: number;
  paddingY: number;
  borderWidth: number;
  label: { fontSize: number; fontWeight: TextStyle['fontWeight'] };
  press: { scale: number; spring: Spring; opacity: number; duration: number };
  focusRing: { color: string; width: number; offset: number };
  loading: { width: number; radius: number; duration: number; easing: Bezier; spinner: { size: number; stroke: number; period: number } };
  success: { spring: Spring };
  primary: Colors;
  secondary: Colors;
  disabled: Colors;
};

export type PrimaryButtonProps = {
  title: string;
  variant?: 'primary' | 'secondary' | 'disabled';
  /** `loading` swaps the label for a spinner on a pill; `success` shows a check. */
  status?: 'idle' | 'loading' | 'success';
  onPress?: () => void;
  testID?: string;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** A state's value, or rest's when the group does not set that state. */
const pick = (values: Partial<Record<ComponentState, string>>, state: ComponentState) => values[state] ?? values.rest ?? 'transparent';

/** The app's shared button. `disabled` is drawn greyed and ignores presses. */
export function PrimaryButton({ title, variant = 'primary', status = 'idle', onPress, testID }: PrimaryButtonProps) {
  const k = useTokens<PrimaryButtonTokens>('primaryButton');
  const mode = useMotionMode();
  const disabled = variant === 'disabled';
  const [live, setLive] = useState<Live>({});
  const [replay, setReplay] = useState<Live | null>(null);
  const flags = { ...live, loading: status === 'loading', success: status === 'success' };
  const forcedOrLive = useComponentState('PrimaryButton', flags);
  const state = disabled ? 'rest' : replay ? deriveState(replay) : forcedOrLive;
  const colors = k[variant];
  const pill = state === 'loading' || state === 'success';

  const size = useSharedValue({ width: 0, height: k.minHeight });
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const background = useSharedValue(pick(colors.background, 'rest'));
  const border = useSharedValue(pick(colors.border, 'rest'));
  const pillOn = useSharedValue(0);
  const shrink = useSharedValue(0);
  const labelShown = useSharedValue(1);
  const spinnerShown = useSharedValue(0);
  const spin = useSharedValue(0);
  const check = useSharedValue(0);
  const ring = useSharedValue(0);

  useEffect(() => {
    const pressed = state === 'pressed';
    scale.value = move(pressed ? k.press.scale : 1, k.press.spring, mode);
    opacity.value = fade(pressed ? k.press.opacity : 1, k.press.duration, mode);
    background.value = fade(pick(colors.background, state), k.press.duration, mode);
    border.value = fade(pick(colors.border, state), k.press.duration, mode);
    ring.value = fade(state === 'focused' ? 1 : 0, k.press.duration, mode);
    labelShown.value = fade(pill ? 0 : 1, k.loading.duration, mode);
    spinnerShown.value = fade(state === 'loading' ? 1 : 0, k.loading.duration, mode);
    check.value = state === 'success' ? move(1, k.success.spring, mode) : fade(0, k.press.duration, mode);
    if (pill) {
      pillOn.value = 1;
      shrink.value = glide(1, k.loading.duration, k.loading.easing, mode);
    } else {
      shrink.value = glide(0, k.loading.duration, k.loading.easing, mode, (finished) => {
        'worklet';
        if (finished) pillOn.value = 0;
      });
    }
  }, [state, pill, mode, k, colors]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state !== 'loading' || mode === 'still') return;
    spin.value = 0;
    // Reduced motion keeps the spinner turning: it says work is under way, and stops when it ends.
    spin.value = withRepeat(withTiming(1, { duration: k.loading.spinner.period, easing: Easing.linear, reduceMotion: ReduceMotion.Never }), -1);
    return () => cancelAnimation(spin);
  }, [state, mode, k.loading.spinner.period]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (steps: [Live | null, number][]) => {
    let at = 0;
    for (const [flags, wait] of steps) {
      setTimeout(() => setReplay(flags), at);
      at += wait;
    }
  };
  useReplay('PrimaryButton', {
    press: () => run([[{}, 60], [{ pressed: true }, 260], [null, 0]]),
    loading: () => run([[{}, 60], [{ loading: true }, 1800], [null, 0]]),
    success: () => run([[{}, 60], [{ loading: true }, 1000], [{ success: true }, 1600], [null, 0]]),
  });

  const pillWidth = (w: number) => {
    'worklet';
    return Math.min(w, k.loading.width);
  };
  const outer = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
    backgroundColor: pillOn.value ? 'transparent' : background.value,
    borderColor: pillOn.value ? 'transparent' : border.value,
  }));
  const pillStyle = useAnimatedStyle(() => {
    const { width, height } = size.value;
    // Absolute children sit inside the border: the pill starts over it.
    const inset = ((width - pillWidth(width)) / 2) * shrink.value - k.borderWidth;
    const round = Math.min(k.loading.radius, height / 2);
    return {
      opacity: pillOn.value,
      left: inset,
      right: inset,
      borderRadius: k.radius + (round - k.radius) * shrink.value,
      backgroundColor: background.value,
      borderColor: border.value,
    };
  });
  const labelStyle = useAnimatedStyle(() => ({ opacity: labelShown.value }));
  const spinnerStyle = useAnimatedStyle(() => ({ opacity: spinnerShown.value, transform: [{ rotate: `${spin.value * 360}deg` }] }));
  // The check is an L (a short left arm, a long bottom arm) turned 45° left. Turned,
  // its drawn box sits (h - stroke)·√½ / 2 below the box it turns in: lift it by that.
  const tick = { width: k.loading.spinner.size * 0.62, height: k.loading.spinner.size * 0.34, stroke: k.loading.spinner.stroke + 0.5 };
  const lift = (Math.SQRT1_2 * (tick.height - tick.stroke)) / 2;
  const checkStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, check.value * 2),
    transform: [{ scale: check.value }, { rotate: '-45deg' }],
  }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value }));

  const ink = pick(colors.label, state);
  const spinner = k.loading.spinner;
  const ringInset = -(k.borderWidth + k.focusRing.offset + k.focusRing.width);
  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: state === 'loading' }}
      disabled={disabled || pill}
      onPress={onPress}
      onPressIn={() => setLive((l) => ({ ...l, pressed: true }))}
      onPressOut={() => setLive((l) => ({ ...l, pressed: false }))}
      onHoverIn={() => setLive((l) => ({ ...l, hovered: true }))}
      onHoverOut={() => setLive((l) => ({ ...l, hovered: false }))}
      onFocus={() => setLive((l) => ({ ...l, focused: true }))}
      onBlur={() => setLive((l) => ({ ...l, focused: false }))}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        size.value = { width, height };
      }}
      style={[
        styles.button,
        {
          minHeight: k.minHeight,
          borderRadius: k.radius,
          paddingHorizontal: k.paddingX,
          paddingVertical: k.paddingY,
          borderWidth: k.borderWidth,
          backgroundColor: pick(colors.background, 'rest'),
          borderColor: pick(colors.border, 'rest'),
        },
        outer,
      ]}>
      <Animated.View
        style={[
          styles.passThrough,
          styles.ring,
          { top: ringInset, bottom: ringInset, left: ringInset, right: ringInset, borderRadius: k.radius + k.focusRing.offset + k.focusRing.width },
          { borderWidth: k.focusRing.width, borderColor: k.focusRing.color },
          ringStyle,
        ]}
      />
      <Animated.View style={[styles.passThrough, styles.pill, { borderWidth: k.borderWidth, top: -k.borderWidth, bottom: -k.borderWidth }, pillStyle]} />
      <Animated.View style={labelStyle}>
        <Text numberOfLines={1} style={{ color: ink, fontSize: k.label.fontSize, fontWeight: k.label.fontWeight }}>
          {title}
        </Text>
      </Animated.View>
      <View style={[styles.passThrough, styles.center]}>
        <Animated.View style={[{ width: spinner.size, height: spinner.size }, spinnerStyle]}>
          <View style={[styles.fill, { borderRadius: spinner.size / 2, borderWidth: spinner.stroke, borderColor: ink, opacity: 0.25 }]} />
          <View style={[styles.fill, { borderRadius: spinner.size / 2, borderWidth: spinner.stroke, borderColor: 'transparent', borderTopColor: ink }]} />
        </Animated.View>
      </View>
      <View style={[styles.passThrough, styles.center]}>
        {/* The lift is layout, not a transform: the web rasterises a transform's offset a fraction off. A centred box moves half its negative margin. */}
        <Animated.View
          style={[
            { width: tick.width, height: tick.height, marginTop: -2 * lift },
            { borderLeftWidth: tick.stroke, borderBottomWidth: tick.stroke, borderColor: pick(colors.label, 'success') },
            checkStyle,
          ]}
        />
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  passThrough: { pointerEvents: 'none' },
  button: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute' },
  pill: { position: 'absolute' },
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
