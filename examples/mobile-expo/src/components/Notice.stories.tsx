import type { Meta, StoryObj } from '@storybook/react-native-web-vite';

import { resolved } from '@/copy';

import { Notice } from './Notice';
import { OfflineBanner } from './OfflineBanner';

const meta = { title: 'Components/Notice', component: Notice } satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Warning: Story = {
  args: {
    tone: 'warning',
    title: String(resolved.trial_ended_title),
    body: String(resolved.trial_ended_body),
    action: { title: String(resolved.trial_ended_cta), onPress: () => {} },
  },
};
export const Danger: Story = {
  args: { tone: 'danger', title: String(resolved.session_expired_title), body: String(resolved.session_expired_body) },
};
export const Info: Story = { args: { tone: 'info', title: String(resolved.alerts_count_one), dismissible: true } };
export const Offline: Story = { args: Info.args as Story['args'], render: () => <OfflineBanner onRetry={() => {}} /> };
