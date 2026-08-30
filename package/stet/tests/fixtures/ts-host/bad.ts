// The typo case. With the generated ambient types in the program, this key is
// not in the registry and the host's type check fails before deploy.
import type { ContentKey } from '@getstet/stet';

export const typo: ContentKey = 'hero_headlin';
