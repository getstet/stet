import { copyMap } from '@/lib/content';
export const Faq = () => <ul>{Object.entries(copyMap).filter(([k]) => k.startsWith('faq')).map(([k, v]) => <li key={k}>{v}</li>)}</ul>;
