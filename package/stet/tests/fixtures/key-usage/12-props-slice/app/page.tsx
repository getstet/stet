import { copyMap } from '@/lib/content';
import { Hero } from './hero';
export default function Page() { return <Hero words={copyMap} />; }
