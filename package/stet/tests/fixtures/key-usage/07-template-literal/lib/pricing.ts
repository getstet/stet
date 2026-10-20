import { copy } from '@/lib/content';
export const tiers = ['solo', 'team'].map((id) => ({ id, name: copy(`tier_${id}_name`) }));
