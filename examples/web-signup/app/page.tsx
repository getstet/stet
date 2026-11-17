'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useSession } from '@/lib/session';

export default function IndexPage() {
  const user = useSession();
  const router = useRouter();
  useEffect(() => {
    if (user !== undefined) router.replace(user === null ? '/signup' : '/dashboard');
  }, [user, router]);
  return null;
}
