import { copy } from '@/lib/content';
type Status = 'open' | 'closed';
const LABEL: Record<Status, string> = { open: 'status_open', closed: 'status_closed' };
export const Badge = ({ s }: { s: Status }) => <span>{copy(LABEL[s])}</span>;
