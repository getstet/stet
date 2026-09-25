'use client';

import type { ReactNode } from 'react';

export interface PrimaryButtonProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  type?: 'button' | 'submit';
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function PrimaryButton({ children, variant = 'primary', type = 'button', busy = false, disabled = false, onClick }: PrimaryButtonProps) {
  return (
    <button
      type={type}
      className={`button button-${variant}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span className="button-label">{children}</span>
    </button>
  );
}
