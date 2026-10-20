import { copy } from '@/lib/content';
const KEYS = ['hero_title', 'footer_note'] as const;
export default function Page() { return <>{KEYS.map((k) => <p key={k}>{copy(k)}</p>)}</>; }
