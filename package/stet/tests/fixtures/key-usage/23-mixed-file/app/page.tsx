import { copy } from '@/lib/content';
const SECTION = 'home_';
export default function Page({ k }: { k: string }) { return <><h1>{copy(SECTION + 'title')}</h1><p>{copy(k)}</p></>; }
