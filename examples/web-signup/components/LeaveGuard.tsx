'use client';

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

type Blocker = (href: string) => void;

interface LeaveGuardValue {
  /** Go to `href`, unless a screen with unsaved changes asks first. */
  leave: (href: string) => void;
  /** While set, `leave` hands the destination to `blocker` instead of going. */
  block: (blocker: Blocker | null) => void;
}

const LeaveGuardContext = createContext<LeaveGuardValue | null>(null);

export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const blocker = useRef<Blocker | null>(null);
  const leave = useCallback((href: string) => {
    if (blocker.current !== null) blocker.current(href);
    else router.push(href);
  }, [router]);
  const block = useCallback((next: Blocker | null) => {
    blocker.current = next;
  }, []);
  const value = useMemo(() => ({ leave, block }), [leave, block]);
  return <LeaveGuardContext.Provider value={value}>{children}</LeaveGuardContext.Provider>;
}

export function useLeaveGuard(): LeaveGuardValue {
  const value = useContext(LeaveGuardContext);
  if (value === null) throw new Error('useLeaveGuard() needs a <LeaveGuardProvider>');
  return value;
}
