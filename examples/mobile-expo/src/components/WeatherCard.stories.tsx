import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { WeatherCard } from './WeatherCard';

const meta = { title: 'Components/WeatherCard', component: WeatherCard, args: { onRetry: () => {} } } satisfies Meta<typeof WeatherCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loaded: Story = {
  args: { state: { status: 'loaded', weather: { city: 'Lisbon', temperature: 21, high: 24, low: 15, code: 2 } } },
};
export const Loading: Story = { args: { state: { status: 'loading' } } };
export const Failed: Story = { args: { state: { status: 'failed', reason: 'unavailable' } } };
export const CityNotFound: Story = { args: { state: { status: 'not-found', query: 'Atlantis' } } };
