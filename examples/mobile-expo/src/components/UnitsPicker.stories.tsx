import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { UnitsPicker } from './UnitsPicker';

const meta = { title: 'Components/UnitsPicker', component: UnitsPicker, args: { onChange: () => {} } } satisfies Meta<typeof UnitsPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Celsius: Story = { args: { value: 'celsius' } };
export const Fahrenheit: Story = { args: { value: 'fahrenheit' } };
export const Pressed: Story = { args: { value: 'celsius' }, parameters: { states: { UnitsPicker: 'pressed' } } };
export const Focused: Story = { args: { value: 'celsius' }, parameters: { states: { UnitsPicker: 'focused' } } };
