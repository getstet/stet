import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { resolved } from '@/copy';

import { PrimaryButton } from './PrimaryButton';

const meta = { title: 'Components/PrimaryButton', component: PrimaryButton } satisfies Meta<typeof PrimaryButton>;
export default meta;
type Story = StoryObj<typeof meta>;

const primary = { title: String(resolved.welcome_create_account), variant: 'primary' } as const;
const secondary = { title: String(resolved.welcome_sign_in), variant: 'secondary' } as const;
const forced = (state: string) => ({ states: { PrimaryButton: state } });

export const Primary: Story = { args: primary };
export const PrimaryPressed: Story = { args: primary, parameters: forced('pressed') };
export const PrimaryHovered: Story = { args: primary, parameters: forced('hovered') };
export const PrimaryFocused: Story = { args: primary, parameters: forced('focused') };
export const PrimaryLoading: Story = { args: { ...primary, status: 'loading' } };
export const PrimarySuccess: Story = { args: { ...primary, status: 'success' } };
export const Secondary: Story = { args: secondary };
export const SecondaryPressed: Story = { args: secondary, parameters: forced('pressed') };
export const SecondaryHovered: Story = { args: secondary, parameters: forced('hovered') };
export const SecondaryFocused: Story = { args: secondary, parameters: forced('focused') };
export const SecondaryLoading: Story = { args: { ...secondary, status: 'loading' } };
export const SecondarySuccess: Story = { args: { ...secondary, status: 'success' } };
export const Disabled: Story = { args: { title: String(resolved.onboarding_continue), variant: 'disabled' } };
