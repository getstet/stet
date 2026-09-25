'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCopy } from '@getstet/stet/react';

import { Dialog } from '@/components/Dialog';
import { useLeaveGuard } from '@/components/LeaveGuard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { TextField } from '@/components/TextField';
import { ToggleRow } from '@/components/ToggleRow';
import { saveSettings } from '@/lib/api';
import { screenSeed } from '@/lib/screen-seed';
import { useSession, type User } from '@/lib/session';

interface SettingsSeed {
  name?: string;
  prefs?: User['prefs'];
  submit?: boolean;
  leaving?: string;
}

type Phase = 'editing' | 'saving' | 'saved';

function SettingsForm({ user }: { user: User }) {
  const copy = useCopy();
  const router = useRouter();
  const { leave, block } = useLeaveGuard();
  const [name, setName] = useState(user.name);
  const [prefs, setPrefs] = useState(user.prefs);
  const [phase, setPhase] = useState<Phase>('editing');
  const [nameMissing, setNameMissing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const seeded = useRef(false);

  const dirty = name !== user.name || prefs.updates !== user.prefs.updates || prefs.summary !== user.prefs.summary;

  useEffect(() => {
    block(dirty ? setPending : null);
    return () => block(null);
  }, [dirty, block]);

  async function save(nameValue: string, prefsValue: User['prefs']) {
    if (nameValue.trim() === '') {
      setNameMissing(true);
      return;
    }
    setNameMissing(false);
    setPhase('saving');
    await saveSettings({ name: nameValue.trim(), prefs: prefsValue });
    setName(nameValue.trim());
    setPhase('saved');
  }

  useEffect(() => {
    const seed = screenSeed<SettingsSeed>('/settings');
    if (seed === undefined || seeded.current) return;
    seeded.current = true;
    const nextName = seed.name ?? user.name;
    const nextPrefs = seed.prefs ?? user.prefs;
    setName(nextName);
    setPrefs(nextPrefs);
    if (seed.leaving !== undefined) setPending(seed.leaving);
    if (seed.submit) void save(nextName, nextPrefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPhase('editing');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">{copy('settings_title')}</h1>
        <PrimaryButton variant="secondary" onClick={() => leave('/dashboard')}>{copy('settings_back')}</PrimaryButton>
      </div>
      <form
        className="card form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save(name, prefs);
        }}
      >
        <h2 className="section-title">{copy('settings_profile_title')}</h2>
        <TextField
          label={copy('settings_name_label')}
          value={name}
          onChange={edit(setName)}
          hint={copy('settings_name_hint')}
          error={nameMissing ? copy('settings_name_required') : undefined}
          autoComplete="name"
        />
        <h2 className="section-title">{copy('settings_email_title')}</h2>
        <ToggleRow
          label={copy('settings_pref_updates')}
          hint={copy('settings_pref_updates_hint')}
          checked={prefs.updates}
          onChange={edit((updates: boolean) => setPrefs((current) => ({ ...current, updates })))}
        />
        <ToggleRow
          label={copy('settings_pref_summary')}
          hint={copy('settings_pref_summary_hint')}
          checked={prefs.summary}
          onChange={edit((summary: boolean) => setPrefs((current) => ({ ...current, summary })))}
        />
        <div className="form-actions">
          <PrimaryButton type="submit" busy={phase === 'saving'} disabled={!dirty && phase !== 'saving'}>
            {phase === 'saving' ? copy('settings_saving') : copy('settings_save')}
          </PrimaryButton>
          {phase === 'saved' && !dirty ? (
            <p className="status status-success" role="status">{copy('settings_saved')}</p>
          ) : dirty && phase !== 'saving' ? (
            <p className="status">{copy('settings_unsaved')}</p>
          ) : null}
        </div>
      </form>
      {pending !== null ? (
        <Dialog
          title={copy('settings_discard_title')}
          actions={
            <>
              <PrimaryButton variant="secondary" onClick={() => setPending(null)}>{copy('settings_discard_keep')}</PrimaryButton>
              <PrimaryButton
                onClick={() => {
                  block(null);
                  router.push(pending);
                }}
              >
                {copy('settings_discard_confirm')}
              </PrimaryButton>
            </>
          }
        >
          <p>{copy('settings_discard_body')}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const user = useSession();
  if (!user) return null;
  return <SettingsForm user={user} />;
}
