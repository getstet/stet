import { liveDefaults } from '@/lib/copy/landing';
export default function Page({ copy: c = liveDefaults }) { return <section><p>{c.home_live_kicker}</p><h2>{c.home_live_headline}</h2></section>; }
