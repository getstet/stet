'use client';
import { useCopy } from '@getstet/stet/react';
export default function Page() { const t = useCopy(); return <h1>{t('hero_title')}</h1>; }
