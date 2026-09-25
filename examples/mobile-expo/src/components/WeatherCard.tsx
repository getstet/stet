import { StyleSheet, Text, View } from 'react-native';

import { conditionKey, type WeatherState } from '@/api/weather';
import { PrimaryButton } from '@/components/PrimaryButton';
import { fill, useCopy } from '@/copy';
import { useTheme } from '@/theme';

/** Today's weather for one city, or why it isn't there. */
export function WeatherCard({ state, onRetry }: { state: WeatherState; onRetry: () => void }) {
  const t = useTheme();
  const copy = useCopy();
  const card = { backgroundColor: t.color.surface, borderRadius: t.radius.card, padding: t.space.lg, gap: t.space.sm };
  const heading = { color: t.color.text, fontSize: t.font.size.heading, fontWeight: t.font.weight.bold };
  const body = { color: t.color.textMuted, fontSize: t.font.size.body };

  if (state.status === 'loading') {
    return (
      <View testID="weather-card-loading" style={card}>
        <Text style={body}>{copy('weather_loading')}</Text>
        <View style={[styles.bar, { width: '60%', backgroundColor: t.color.border }]} />
        <View style={[styles.block, { backgroundColor: t.color.border }]} />
        <View style={[styles.bar, { width: '40%', backgroundColor: t.color.border }]} />
      </View>
    );
  }
  if (state.status === 'failed') {
    return (
      <View testID="weather-card-failed" style={card}>
        <Text style={heading}>{copy('weather_error_title')}</Text>
        <Text style={body}>{copy('weather_error_body')}</Text>
        <PrimaryButton title={copy('weather_retry_label')} onPress={onRetry} />
      </View>
    );
  }
  if (state.status === 'not-found') {
    return (
      <View testID="weather-card-not-found" style={card}>
        <Text style={heading}>{fill(copy('city_not_found_title'), { city: state.query })}</Text>
        <Text style={body}>{copy('city_not_found_body')}</Text>
      </View>
    );
  }
  const w = state.weather;
  return (
    <View testID="weather-card-loaded" style={card}>
      <Text style={body}>{fill(copy('weather_now_label'), { city: w.city })}</Text>
      <View style={styles.row}>
        <Text style={{ color: t.color.text, fontSize: 64, fontWeight: t.font.weight.regular }}>{w.temperature}°</Text>
        <Text style={[heading, styles.condition]}>{copy(conditionKey(w.code))}</Text>
      </View>
      <Text style={body}>{fill(copy('weather_high_low'), { high: w.high, low: w.low })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  condition: { flexShrink: 1 },
  bar: { height: 14, borderRadius: 7 },
  block: { height: 64, width: 120, borderRadius: 12 },
});
