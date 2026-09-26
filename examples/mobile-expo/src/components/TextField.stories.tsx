import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { resolved } from '@/copy';

import { TextField } from './TextField';

const meta = { title: 'Components/TextField', component: TextField } satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

const floating = { label: String(resolved.email_label), value: '' };

export const Plain: Story = { args: { placeholder: String(resolved.city_search_placeholder), value: '' } };
export const PlainFocused: Story = { args: { placeholder: String(resolved.city_search_placeholder), value: '' }, parameters: { states: { TextField: 'focused' } } };
export const Floating: Story = { args: floating };
export const FloatingFilled: Story = { args: { ...floating, value: 'ada@example.com' } };
export const FloatingFocused: Story = { args: floating, parameters: { states: { TextField: 'focused' } } };
export const WithHint: Story = { args: { label: String(resolved.password_label), value: '', hint: String(resolved.create_account_password_hint) } };
export const WithError: Story = { args: { ...floating, value: 'ada@example.com', error: String(resolved.sign_in_error) } };
