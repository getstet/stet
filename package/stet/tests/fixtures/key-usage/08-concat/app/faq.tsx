import { copy } from '@/lib/content';
export const Faq = () => <ul>{[1, 2].map((n) => <li key={n}>{copy('home_faq_' + n + '_question')}</li>)}</ul>;
