'use client';

import { useId } from 'react';

export interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  const id = useId();
  return (
    <div className="toggle-row">
      <input id={id} type="checkbox" className="toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id} className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-hint">{hint}</span>
      </label>
    </div>
  );
}
