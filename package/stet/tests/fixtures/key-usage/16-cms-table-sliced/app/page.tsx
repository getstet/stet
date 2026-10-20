import { copyMap } from '@/lib/content';
import table from './sections.json';
const words: Record<string, string> = { ...copyMap };
export default function Page({ name = 'home' }) { const s = table[name as keyof typeof table]; return <><h1>{words[s.heading]}</h1><p>{words[s.foot]}</p></>; }
