// A host that references registered keys. It compiles, and the accessor's
// callable form types as a string.
import { createAccessor, type ContentKey, type Descriptor } from '@getstet/stet';

const registered: ContentKey = 'hero_headline';

const descriptor: Descriptor = {
  version: 1,
  keys: {
    hero_headline: { shape: 'text', target: 'web' },
  },
};

const copy = createAccessor(descriptor, { hero_headline: 'Never miss a post again.' });

export const headline: string = copy(registered);
