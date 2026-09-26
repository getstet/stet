import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { useTokens, type Spring } from '@/theme';
import { fade, move, useMotionMode } from '@/theme/motion';
import { useComponentState, useReplay } from '@/theme/state';

export type ToggleTokens = {
  width: number;
  height: number;
  thumbSize: number;
  track: { on: string; off: string };
  thumb: { rest: string };
  press: { stretch: number };
  spring: Spring;
  duration: number;
};

type Props = {
  on: boolean;
  /** Given when the switch takes presses itself; a settings row passes its own press state instead. */
  onChange?: (on: boolean) => void;
  pressed?: boolean;
  focused?: boolean;
  testID?: string;
};

/** An on/off switch: the thumb springs across and the track changes colour. Held down, the thumb stretches. */
export function Toggle({ on, onChange, pressed: rowPressed, focused, testID }: Props) {
  const k = useTokens<ToggleTokens>('toggle');
  const mode = useMotionMode();
  const [ownPressed, setOwnPressed] = useState(false);
  const [replayed, setReplayed] = useState<boolean | null>(null);
  const state = useComponentState('Toggle', { pressed: rowPressed || ownPressed, focused });
  const shown = replayed ?? on;

  useReplay('Toggle', {
    toggle: () => {
      setTimeout(() => setReplayed(!on), 60);
      setTimeout(() => setReplayed(null), 1100);
    },
  });

  const inset = (k.height - k.thumbSize) / 2;
  const at = useSharedValue(shown ? 1 : 0);
  const stretch = useSharedValue(0);
  const track = useSharedValue(shown ? k.track.on : k.track.off);
  useEffect(() => {
    at.value = move(shown ? 1 : 0, k.spring, mode);
    track.value = fade(shown ? k.track.on : k.track.off, k.duration, mode);
  }, [shown, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    stretch.value = move(state === 'pressed' ? k.press.stretch : 0, k.spring, mode);
  }, [state, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps

  const trackStyle = useAnimatedStyle(() => ({ backgroundColor: track.value }));
  const thumbStyle = useAnimatedStyle(() => {
    const travel = k.width - 2 * inset - k.thumbSize - stretch.value;
    return { width: k.thumbSize + stretch.value, transform: [{ translateX: inset + at.value * travel }] };
  });

  return (
    <Pressable
      testID={testID}
      disabled={!onChange}
      accessible={Boolean(onChange)}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      onPress={() => onChange?.(!on)}
      onPressIn={() => setOwnPressed(true)}
      onPressOut={() => setOwnPressed(false)}>
      <Animated.View
        style={[
          styles.track,
          { width: k.width, height: k.height, borderRadius: k.height / 2, backgroundColor: shown ? k.track.on : k.track.off },
          state === 'focused' && { outlineColor: k.track.on, outlineWidth: 2, outlineOffset: 2, outlineStyle: 'solid' },
          trackStyle,
        ]}>
        <Animated.View
          style={[styles.thumb, { top: inset, height: k.thumbSize, borderRadius: k.thumbSize / 2, backgroundColor: k.thumb.rest }, thumbStyle]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { justifyContent: 'center' },
  thumb: { position: 'absolute', left: 0, boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.3)' },
});
