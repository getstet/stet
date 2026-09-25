import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { resolved } from '@/copy';

import { PrimaryButton } from './PrimaryButton';

const meta = { title: 'Components/PrimaryButton', component: PrimaryButton } satisfies Meta<typeof PrimaryButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { title: String(resolved.welcome_create_account), variant: 'primary' } };
export const Secondary: Story = { args: { title: String(resolved.welcome_sign_in), variant: 'secondary' } };
export const Disabled: Story = { args: { title: String(resolved.onboarding_continue), variant: 'disabled' } };
