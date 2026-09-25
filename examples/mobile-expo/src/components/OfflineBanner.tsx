import { useCopy } from '@/copy';

import { Notice } from './Notice';

/** Shown while the device has no connection. */
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const copy = useCopy();
  return (
    <Notice
      testID="offline-banner"
      tone="warning"
      title={copy('offline_title')}
      body={copy('offline_body')}
      action={{ title: copy('offline_retry_label'), onPress: onRetry, variant: 'secondary' }}
    />
  );
}
