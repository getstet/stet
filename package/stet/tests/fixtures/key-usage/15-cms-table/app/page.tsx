import { copy } from '@/lib/content';
import table from './sections.json';
export default function Page({ name = 'home' }) { const s = table[name as keyof typeof table]; return <h1>{copy(s.heading)}</h1>; }
