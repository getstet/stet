import { all } from '@/lib/copy/landing';
export default function Page({ field }: { field: string }) { return <p>{all[field]}</p>; }
