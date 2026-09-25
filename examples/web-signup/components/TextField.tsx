'use client';

import { useId } from 'react';

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email';
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  autoComplete?: string;
}

export function TextField({ label, value, onChange, type = 'text', placeholder, hint, error, disabled, autoComplete }: TextFieldProps) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id} className="field-label">{label}</label>
      <input
        id={id}
        className="field-input"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {note ? <p id={`${id}-note`} className={error ? 'field-error' : 'field-hint'}>{note}</p> : null}
    </div>
  );
}
