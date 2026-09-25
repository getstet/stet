'use client';

import { useEffect, type ReactNode } from 'react';

export interface DialogProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}

export function Dialog({ title, children, actions }: DialogProps) {
  // The page behind a dialog does not scroll while it is open.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title" className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}
