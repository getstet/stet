import { useTranslations } from '@/lib/i18n';
export default function Page() { const t = useTranslations('home'); return <h1>{t('title')}</h1>; }
