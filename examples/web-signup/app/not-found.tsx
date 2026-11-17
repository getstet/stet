'use client';

import Link from 'next/link';
import { useCopy } from '@getstet/stet/react';

export default function NotFound() {
  const copy = useCopy();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">{copy('app_name')}</p>
        <h1 className="title">{copy('not_found_title')}</h1>
        <Link className="button button-primary" href="/dashboard">{copy('not_found_link')}</Link>
      </div>
    </main>
  );
}
