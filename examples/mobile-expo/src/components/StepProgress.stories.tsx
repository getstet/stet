import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { StepProgress } from './StepProgress';

const meta = { title: 'Components/StepProgress', component: StepProgress, args: { of: 3 } } satisfies Meta<typeof StepProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Step1: Story = { args: { step: 1 } };
export const Step2: Story = { args: { step: 2 } };
export const Step3: Story = { args: { step: 3 } };
