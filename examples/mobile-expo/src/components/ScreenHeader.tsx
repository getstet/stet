import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCopy } from '@/copy';
import { useTheme } from '@/theme';

import { StepProgress } from './StepProgress';

type Props = { title: string; eyebrow?: string; back?: boolean | (() => void); progress?: { step: number; of: number } };

/** A back link, an optional progress bar and small line above the title, and the title. */
export function ScreenHeader({ title, eyebrow, back, progress }: Props) {
  const t = useTheme();
  const copy = useCopy();
  const onBack = typeof back === 'function' ? back : () => router.back();
  return (
    <View style={{ gap: t.space.sm, marginBottom: t.space.sm }}>
      {back ? (
        <Pressable testID="back" accessibilityRole="button" onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={[styles.chevron, { color: t.color.primary, fontSize: t.font.size.heading }]}>‹</Text>
          <Text style={{ color: t.color.primary, fontSize: t.font.size.body, fontWeight: t.font.weight.semibold }}>
            {copy('nav_back_label')}
          </Text>
        </Pressable>
      ) : null}
      {progress ? <StepProgress step={progress.step} of={progress.of} /> : null}
      {eyebrow ? (
        <Text style={{ color: t.color.textMuted, fontSize: t.font.size.caption, fontWeight: t.font.weight.semibold }}>{eyebrow}</Text>
      ) : null}
      <Text accessibilityRole="header" style={{ color: t.color.text, fontSize: t.font.size.title, fontWeight: t.font.weight.bold }}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  chevron: { fontWeight: '600', marginTop: -2 },
});
