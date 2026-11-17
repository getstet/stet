'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCopy } from '@getstet/stet/react';

import { PrimaryButton } from '@/components/PrimaryButton';
import { fill } from '@/lib/fill';
import { useSession } from '@/lib/session';

export default function WelcomePage() {
  const copy = useCopy();
  const router = useRouter();
  const user = useSession();
  useEffect(() => {
    if (user === null) router.replace('/signup');
  }, [user, router]);
  if (!user) return null;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">{copy('app_name')}</p>
        <h1 className="title">{fill(copy('welcome_title'), { name: user.name })}</h1>
        <p className="lead">{copy('welcome_body')}</p>
        <PrimaryButton onClick={() => router.push('/dashboard')}>{copy('welcome_cta')}</PrimaryButton>
      </div>
    </main>
  );
}
