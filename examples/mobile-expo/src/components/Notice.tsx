import { useEffect, useState } from 'react';
import { Text, View, type TextStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';

import { PrimaryButton } from '@/components/PrimaryButton';
import { useCopy } from '@/copy';
import { useTokens, type Spring } from '@/theme';
import { fade, glide, move, useMotionMode } from '@/theme/motion';
import { useReplay } from '@/theme/state';

type Tone = 'info' | 'warning' | 'danger';

export type NoticeTokens = {
  radius: number;
  padding: number;
  gap: number;
  /** The gap the screen's column puts after each card: a dismissed card closes it too. */
  stackGap: number;
  title: { fontSize: number; fontWeight: TextStyle['fontWeight'] };
  body: { fontSize: number; color: string };
  enter: { offset: number; spring: Spring };
  swipe: { threshold: number; spring: Spring; duration: number };
} & Record<Tone, { background: { rest: string }; title: { rest: string } }>;

type Props = {
  tone: Tone;
  title: string;
  body?: string;
  action?: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' };
  /** A sideways swipe, or the screen reader's dismiss action, puts it away until the screen is left. */
  dismissible?: boolean;
  testID?: string;
  /** The name development tooling replays it under. */
  componentName?: string;
};

const LINEAR: [number, number, number, number] = [0.4, 0, 1, 1];

/** A card that tells the user something about their account or connection. It slides in from above. */
export function Notice({ tone, title, body, action, dismissible, testID, componentName = 'Notice' }: Props) {
  const k = useTokens<NoticeTokens>('notice');
  const copy = useCopy();
  const mode = useMotionMode();
  const [dismissed, setDismissed] = useState(false);

  const shown = useSharedValue(mode === 'still' ? 1 : 0);
  const drop = useSharedValue(mode === 'full' ? -k.enter.offset : 0);
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const open = useSharedValue(1);

  const enter = () => {
    shown.value = mode === 'still' ? 1 : 0;
    drop.value = mode === 'full' ? -k.enter.offset : 0;
    shown.value = fade(1, k.swipe.duration, mode);
    drop.value = move(0, k.enter.spring, mode);
  };
  useEffect(enter, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Off to one side, then the space it took closes. `restore` brings it back (replays). */
  const dismiss = (direction: number, restore = false) => {
    'worklet';
    const done = (finished?: boolean) => {
      'worklet';
      if (!finished) return;
      if (restore) {
        x.value = 0;
        open.value = withDelay(500, glide(1, k.swipe.duration, LINEAR, mode));
        shown.value = withDelay(500, fade(1, k.swipe.duration, mode));
      } else runOnJS(setDismissed)(true);
    };
    const away = direction * (width.value + 40);
    if (mode === 'full') x.value = withTiming(away, { duration: k.swipe.duration });
    shown.value = fade(0, k.swipe.duration, mode);
    open.value = withDelay(mode === 'full' ? k.swipe.duration : 0, glide(0, k.swipe.duration, LINEAR, mode, done));
  };

  useReplay(componentName, {
    'banner-in': enter,
    dismiss: () => dismiss(1, true),
    'spring-back': () => {
      x.value = mode === 'full' ? withSequence(withTiming(width.value * k.swipe.threshold * 0.7, { duration: 260 }), move(0, k.swipe.spring, mode)) : 0;
    },
  });

  const pan = Gesture.Pan()
    .enabled(Boolean(dismissible))
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      x.value = e.translationX;
    })
    .onEnd((e) => {
      const far = Math.abs(x.value) > width.value * k.swipe.threshold || Math.abs(e.velocityX) > 900;
      if (far) dismiss(Math.sign(x.value || e.velocityX));
      else x.value = move(0, k.swipe.spring, mode);
    });

  const card = useAnimatedStyle(() => {
    const dragged = width.value > 0 ? Math.min(1, Math.abs(x.value) / width.value) : 0;
    const closing = height.value > 0 && open.value < 1;
    return {
      opacity: shown.value * (1 - dragged * 0.6),
      transform: [{ translateY: drop.value }, { translateX: x.value }],
      // While the space closes, the card clips what no longer fits; its padding
      // (a box is never shorter than its padding) and the column's gap after it
      // close in the same motion.
      height: closing ? height.value * open.value : 'auto',
      paddingTop: closing ? k.padding * open.value : k.padding,
      paddingBottom: closing ? k.padding * open.value : k.padding,
      marginBottom: closing ? -k.stackGap * (1 - open.value) : 0,
      overflow: closing ? 'hidden' : 'visible',
    };
  });

  if (dismissed) return null;
  const colors = k[tone];
  return (
    <GestureDetector gesture={pan}>
        <Animated.View
          testID={testID}
          accessibilityActions={dismissible ? [{ name: 'dismiss', label: copy('notice_dismiss_label') }] : undefined}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === 'dismiss' && dismiss(1)}
          onLayout={(e) => {
            width.value = e.nativeEvent.layout.width;
            // The open height: a closing card reports its shrinking one.
            if (open.value === 1) height.value = e.nativeEvent.layout.height;
          }}
          style={[{ backgroundColor: colors.background.rest, borderRadius: k.radius, padding: k.padding, gap: k.gap }, card]}>
          <Text style={{ color: colors.title.rest, fontSize: k.title.fontSize, fontWeight: k.title.fontWeight }}>{title}</Text>
          {body ? <Text style={{ color: k.body.color, fontSize: k.body.fontSize }}>{body}</Text> : null}
          {action ? <PrimaryButton title={action.title} variant={action.variant ?? 'primary'} onPress={action.onPress} /> : null}
        </Animated.View>
    </GestureDetector>
  );
}
