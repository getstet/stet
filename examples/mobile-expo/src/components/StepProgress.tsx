import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { useTokens, type Spring } from '@/theme';
import { move, useMotionMode } from '@/theme/motion';
import { useReplay } from '@/theme/state';

export type StepProgressTokens = { height: number; radius: number; track: string; fill: string; spring: Spring };

/** How far through onboarding: arriving on a step, the fill grows from the step before. */
export function StepProgress({ step, of }: { step: number; of: number }) {
  const k = useTokens<StepProgressTokens>('stepProgress');
  const mode = useMotionMode();
  const [run, setRun] = useState(0);
  useReplay('StepProgress', { step: () => setRun((n) => n + 1) });

  const width = useSharedValue(0);
  const filled = useSharedValue(mode === 'full' ? (step - 1) / of : step / of);
  useEffect(() => {
    if (mode === 'full') filled.value = (step - 1) / of;
    filled.value = move(step / of, k.spring, mode);
  }, [step, of, run, mode, k]); // eslint-disable-line react-hooks/exhaustive-deps

  const fill = useAnimatedStyle(() => ({ width: width.value * Math.max(0, filled.value) }));
  const radius = Math.min(k.radius, k.height / 2);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: of, now: step }}
      onLayout={(e) => {
        width.value = e.nativeEvent.layout.width;
      }}
      style={[styles.track, { height: k.height, borderRadius: radius, backgroundColor: k.track }]}>
      <Animated.View style={[styles.fill, { borderRadius: radius, backgroundColor: k.fill }, fill]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
});
