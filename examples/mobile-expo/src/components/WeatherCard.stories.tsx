import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { WeatherCard } from './WeatherCard';

const meta = { title: 'Components/WeatherCard', component: WeatherCard, args: { onRetry: () => {} } } satisfies Meta<typeof WeatherCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const loaded = (code: number) => ({ state: { status: 'loaded', weather: { city: 'Lisbon', temperature: 21, high: 24, low: 15, code } } }) as const;

export const Clear: Story = { args: loaded(0) };
export const PartlyCloudy: Story = { args: loaded(2) };
export const Cloudy: Story = { args: loaded(3) };
export const Rain: Story = { args: loaded(61) };
export const Snow: Story = { args: loaded(71) };
export const Storm: Story = { args: loaded(95) };
export const Loading: Story = { args: { state: { status: 'loading' } } };
export const Failed: Story = { args: { state: { status: 'failed', reason: 'unavailable' } } };
export const CityNotFound: Story = { args: { state: { status: 'not-found', query: 'Atlantis' } } };
