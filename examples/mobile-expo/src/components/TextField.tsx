import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { useTokens, type ComponentState, type Spring } from '@/theme';
import { fade, move, useMotionMode } from '@/theme/motion';
import { deriveState, useComponentState, useReplay } from '@/theme/state';

type ByState = Partial<Record<ComponentState, string>> & { rest: string };

export type TextFieldTokens = {
  minHeight: number;
  floatingMinHeight: number;
  radius: number;
  paddingX: number;
  borderWidth: number;
  background: string;
  text: string;
  placeholder: string;
  fontSize: number;
  border: ByState;
  ring: { focused: string; error: string; width: number; duration: number };
  label: ByState;
  labelSize: { rest: number; floated: number };
  labelSpring: Spring;
  message: { fontSize: number; hint: string; error: string };
  shake: { amplitude: number; duration: number; count: number };
};

type Props = Omit<TextInputProps, 'style'> & { label?: string; hint?: string; error?: string };

// The floated label's top, in points from the field's edge. At rest it is centred.
const FLOAT_TOP = 7;

/**
 * A text input with an optional label that sits in the field and floats up
 * when the field is focused or filled, and a hint or error under it. A focus
 * ring grows in around it; a new error shakes it.
 */
export function TextField({ label, hint, error, onFocus, onBlur, ...input }: Props) {
  const k = useTokens<TextFieldTokens>('textField');
  const mode = useMotionMode();
  const [focused, setFocused] = useState(false);
  const [replayFocus, setReplayFocus] = useState(false);
  const live = useComponentState('TextField', { focused, error: Boolean(error) });
  const state = replayFocus ? deriveState({ focused: true }) : live;
  const floating = Boolean(label);
  const filled = Boolean(input.value);
  const floated = floating && (filled || state === 'focused' || focused);
  const pick = (values: ByState) => values[state] ?? values.rest;

  const lift = useSharedValue(floated ? 1 : 0);
  const ring = useSharedValue(0);
  const border = useSharedValue(pick(k.border));
  const labelInk = useSharedValue(pick(k.label));
  const shift = useSharedValue(0);

  useEffect(() => {
    lift.value = move(floated ? 1 : 0, k.labelSpring, mode);
  }, [floated, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ringOn = state === 'focused' || state === 'error';
    ring.value = fade(ringOn ? 1 : 0, k.ring.duration, mode);
    border.value = fade(pick(k.border), k.ring.duration, mode);
    labelInk.value = fade(pick(k.label), k.ring.duration, mode);
  }, [state, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps

  const shake = () => {
    if (mode !== 'full') return;
    const { amplitude: a, duration, count } = k.shake;
    const step = duration / (2 * count + 1);
    const moves = [];
    for (let i = 0; i < count; i += 1) {
      const size = a * (1 - i / count);
      moves.push(withTiming(size, { duration: step }), withTiming(-size, { duration: step }));
    }
    shift.value = withSequence(...moves, withTiming(0, { duration: step }));
  };
  // A new error shakes the field; one already showing does not shake again.
  const hadError = useRef(Boolean(error));
  useEffect(() => {
    if (error && !hadError.current) shake();
    hadError.current = Boolean(error);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  useReplay('TextField', {
    shake,
    focus: () => {
      setTimeout(() => setReplayFocus(true), 60);
      setTimeout(() => setReplayFocus(false), 1400);
    },
  });

  const minHeight = floating ? k.floatingMinHeight : k.minHeight;
  const line = Math.round(k.labelSize.rest * 1.25);
  const floatedLine = Math.round(k.labelSize.floated * 1.25);
  const restTop = (minHeight - line) / 2;
  const scale = k.labelSize.floated / k.labelSize.rest;

  const boxStyle = useAnimatedStyle(() => ({ borderColor: border.value, transform: [{ translateX: shift.value }] }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.value, transform: [{ scaleX: 1 + (ring.value - 1) * 0.03 }, { scaleY: 1 + (ring.value - 1) * 0.12 }] }));
  const labelStyle = useAnimatedStyle(() => ({
    color: labelInk.value,
    transform: [{ translateY: lift.value * (FLOAT_TOP - restTop - (line - floatedLine) / 2) }, { scale: 1 + (scale - 1) * lift.value }],
  }));

  const ringColor = state === 'error' ? k.ring.error : k.ring.focused;
  return (
    <View style={styles.column}>
      <Animated.View
        style={[
          styles.box,
          { minHeight, borderRadius: k.radius, borderWidth: k.borderWidth, backgroundColor: k.background, borderColor: pick(k.border) },
          boxStyle,
        ]}>
        <Animated.View
          style={[
            styles.passThrough,
            styles.ring,
            {
              top: -(k.ring.width + k.borderWidth),
              bottom: -(k.ring.width + k.borderWidth),
              left: -(k.ring.width + k.borderWidth),
              right: -(k.ring.width + k.borderWidth),
              borderRadius: k.radius + k.ring.width,
              borderWidth: k.ring.width,
              borderColor: ringColor,
            },
            ringStyle,
          ]}
        />
        <TextInput
          placeholderTextColor={k.placeholder}
          {...input}
          placeholder={floating && !floated ? undefined : input.placeholder}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            styles.input,
            {
              minHeight: minHeight - 2 * k.borderWidth,
              paddingHorizontal: k.paddingX,
              color: k.text,
              fontSize: k.fontSize,
              ...(floating ? { paddingTop: FLOAT_TOP + floatedLine + 2, paddingBottom: 8 } : {}),
            },
          ]}
        />
        {floating ? (
          <Animated.Text
            numberOfLines={1}
            style={[styles.passThrough, styles.label, { left: k.paddingX, top: restTop - k.borderWidth, fontSize: k.labelSize.rest, lineHeight: line, color: pick(k.label) }, labelStyle]}>
            {label}
          </Animated.Text>
        ) : null}
      </Animated.View>
      {error ? <Text style={{ color: k.message.error, fontSize: k.message.fontSize }}>{error}</Text> : null}
      {hint && !error ? <Text style={{ color: k.message.hint, fontSize: k.message.fontSize }}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  passThrough: { pointerEvents: 'none' },
  column: { gap: 6 },
  box: { justifyContent: 'center' },
  ring: { position: 'absolute' },
  input: { outlineWidth: 0 },
  label: { position: 'absolute', fontWeight: '500', transformOrigin: 'left center' },
});
