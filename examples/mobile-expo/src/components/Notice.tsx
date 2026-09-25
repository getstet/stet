import { Text, View } from 'react-native';

import { PrimaryButton } from '@/components/PrimaryButton';
import { useTheme } from '@/theme';

type Props = {
  tone: 'info' | 'warning' | 'danger';
  title: string;
  body?: string;
  action?: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' };
  testID?: string;
};

/** A card that tells the user something about their account or connection. */
export function Notice({ tone, title, body, action, testID }: Props) {
  const t = useTheme();
  const surface = tone === 'danger' ? t.color.dangerSurface : tone === 'warning' ? t.color.warningSurface : t.color.primarySoft;
  const ink = tone === 'danger' ? t.color.danger : tone === 'warning' ? t.color.warning : t.color.primary;
  return (
    <View testID={testID} style={{ backgroundColor: surface, borderRadius: t.radius.card, padding: t.space.md, gap: t.space.sm }}>
      <Text style={{ color: ink, fontSize: t.font.size.body, fontWeight: t.font.weight.bold }}>{title}</Text>
      {body ? <Text style={{ color: t.color.text, fontSize: t.font.size.caption }}>{body}</Text> : null}
      {action ? <PrimaryButton title={action.title} variant={action.variant ?? 'primary'} onPress={action.onPress} /> : null}
    </View>
  );
}

