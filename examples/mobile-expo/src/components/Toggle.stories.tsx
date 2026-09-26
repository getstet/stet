import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { Toggle } from './Toggle';

const meta = { title: 'Components/Toggle', component: Toggle, args: { onChange: () => {} } } satisfies Meta<typeof Toggle>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = { args: { on: false } };
export const On: Story = { args: { on: true } };
export const Pressed: Story = { args: { on: true }, parameters: { states: { Toggle: 'pressed' } } };
export const Focused: Story = { args: { on: false }, parameters: { states: { Toggle: 'focused' } } };
