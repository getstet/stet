import { copy } from '@/lib/content';
export const useTranslations = (ns: string) => (k: string) => copy(`${ns}_${k}`);
