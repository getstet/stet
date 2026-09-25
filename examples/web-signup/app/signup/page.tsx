'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCopy } from '@getstet/stet/react';

import { PrimaryButton } from '@/components/PrimaryButton';
import { TextField } from '@/components/TextField';
import { signUp } from '@/lib/api';
import { fill } from '@/lib/fill';
import { screenSeed } from '@/lib/screen-seed';
import type { User } from '@/lib/session';

interface SignupSeed {
  name: string;
  email: string;
  submit?: boolean;
}

type Phase = 'editing' | 'sending' | 'joined' | 'unavailable';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupPage() {
  const copy = useCopy();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('editing');
  const [invalid, setInvalid] = useState({ name: false, email: false });
  const [joined, setJoined] = useState<User | null>(null);
  const seeded = useRef(false);

  async function submit(nameValue: string, emailValue: string) {
    const next = { name: nameValue.trim() === '', email: !EMAIL.test(emailValue.trim()) };
    setInvalid(next);
    if (next.name || next.email) return;
    setPhase('sending');
    try {
      setJoined(await signUp({ name: nameValue.trim(), email: emailValue.trim() }));
      setPhase('joined');
    } catch {
      setPhase('unavailable');
    }
  }

  useEffect(() => {
    const seed = screenSeed<SignupSeed>('/signup');
    if (seed === undefined || seeded.current) return;
    seeded.current = true;
    setName(seed.name);
    setEmail(seed.email);
    if (seed.submit) void submit(seed.name, seed.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sending = phase === 'sending';

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">{copy('app_name')}</p>
        {phase === 'joined' && joined !== null ? (
          <div className="joined" role="status">
            <h1 className="title">{fill(copy('signup_joined_title'), { name: joined.name })}</h1>
            <p className="lead">{fill(copy('signup_joined_body'), { email: joined.email })}</p>
            <PrimaryButton onClick={() => router.push('/welcome')}>{copy('signup_continue')}</PrimaryButton>
          </div>
        ) : (
          <>
            <h1 className="title">{copy('signup_title')}</h1>
            <p className="lead">{copy('signup_intro')}</p>
            {phase === 'unavailable' ? (
              <div className="notice notice-danger" role="alert">
                <p className="notice-title">{copy('signup_unavailable_title')}</p>
                <p className="notice-body">{copy('signup_unavailable_body')}</p>
              </div>
            ) : null}
            <form
              className="form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit(name, email);
              }}
            >
              <TextField
                label={copy('signup_name_label')}
                value={name}
                onChange={setName}
                autoComplete="name"
                disabled={sending}
                error={invalid.name ? copy('signup_name_required') : undefined}
              />
              <TextField
                label={copy('signup_email_label')}
                type="email"
                value={email}
                onChange={setEmail}
                placeholder={copy('signup_email_placeholder')}
                autoComplete="email"
                disabled={sending}
                error={invalid.email ? copy('signup_email_invalid') : undefined}
              />
              <PrimaryButton type="submit" busy={sending}>
                {sending ? copy('signup_sending') : phase === 'unavailable' ? copy('signup_retry') : copy('signup_submit')}
              </PrimaryButton>
            </form>
            <p className="fine-print">{copy('signup_privacy')}</p>
          </>
        )}
      </div>
    </main>
  );
}
