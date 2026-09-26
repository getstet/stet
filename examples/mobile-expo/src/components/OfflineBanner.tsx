import { useCopy } from '@/copy';

import { Notice } from './Notice';

/** Shown while the device has no connection. A swipe puts it away. */
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const copy = useCopy();
  return (
    <Notice
      testID="offline-banner"
      componentName="OfflineBanner"
      dismissible
      tone="warning"
      title={copy('offline_title')}
      body={copy('offline_body')}
      action={{ title: copy('offline_retry_label'), onPress: onRetry, variant: 'secondary' }}
    />
  );
}
