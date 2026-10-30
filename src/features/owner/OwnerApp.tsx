import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { useSearchParams } from 'react-router-dom';
import { useStudio } from '../../app/StudioContext';
import { ownerClient } from '../../lib/supabase';
import { ErrorState, Loading } from '../../components/States';
import { ForbiddenError, forgetTenantIds, getContext } from './ownerApi';
import { BookingsTab } from './BookingsTab';
import { StatsTab } from './StatsTab';
import { SettingsTab } from './SettingsTab';
import { GalleryTab } from './GalleryTab';
import { clearRuntimeCaches } from '../../pwa/register';
import { AssistantChat } from '../../components/AssistantChat';

type Session = { userId: string } | null;

/** Everything private lives under the query client: on sign-out it is cleared and the session storage removed. */
async function wipePrivateState(slug: string, qc: ReturnType<typeof useQueryClient>) {
  qc.clear();
  forgetTenantIds();
  try {
    await ownerClient(slug).auth.signOut();
  } catch {
    /* offline: the local session is removed below anyway */
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('avto-owner:')) localStorage.removeItem(k);
    sessionStorage.clear();
    void clearRuntimeCaches();
  } catch {
    /* ignore */
  }
  if ('caches' in window) {
    // Private data is never in the service worker cache, but anything stray is removed with the session.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.includes('private')).map((n) => caches.delete(n)));
  }
}

function Login({ onDone }: { onDone: (s: Session) => void }) {
  const studio = useStudio();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const { data, error: e } = await ownerClient(studio.slug).auth.signInWithPassword({ email: email.trim(), password });
    if (e || !data.user) {
      setError('Неверная почта или пароль.');
      return;
    }
    onDone({ userId: data.user.id });
  }

  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <VStack gap={4} padding={4} paddingBlockStart={10} maxWidth={420}>
        <Heading level={1}>Кабинет студии</Heading>
        <Text color="secondary">{studio.name}</Text>
        {error && <Banner status="error" title={error} collapsible={false} />}
        <TextInput label="Почта" type="email" value={email} onChange={setEmail} autoComplete="username" isRequired />
        <TextInput label="Пароль" type="password" value={password} onChange={setPassword} autoComplete="current-password" isRequired onEnter={() => void submit()} />
        <Button label="Войти" variant="primary" type="submit" clickAction={submit} isDisabled={!email || !password} width="100%" />
        <Text type="supporting">Доступ выдаёт администратор студии. Регистрации нет.</Text>
      </VStack>
    </form>
  );
}

const TABS = [
  ['bookings', 'Записи'],
  ['stats', 'Статистика'],
  ['gallery', 'Фото'],
  ['assistant', 'Помощник'],
  ['settings', 'Настройки'],
] as const;

export default function OwnerApp() {
  const studio = useStudio();
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | 'loading'>('loading');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'bookings') as (typeof TABS)[number][0];

  useEffect(() => {
    let alive = true;
    void ownerClient(studio.slug).auth.getSession().then(({ data }) => alive && setSession(data.session ? { userId: data.session.user.id } : null));
    const { data: sub } = ownerClient(studio.slug).auth.onAuthStateChange((_e, s) => {
      if (!s) setSession(null);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [studio.slug]);

  const ctx = useQuery({
    queryKey: ['owner', studio.slug, session === 'loading' || !session ? null : session.userId, 'context'],
    queryFn: () => getContext(studio.slug),
    enabled: !!session && session !== 'loading',
    retry: false,
  });

  async function logout() {
    await wipePrivateState(studio.slug, qc);
    setSession(null);
  }

  if (session === 'loading') return <Loading />;
  if (!session) return <Login onDone={setSession} />;
  if (ctx.isPending) return <Loading label="Открываем кабинет…" />;
  if (ctx.isError) {
    if (ctx.error instanceof ForbiddenError)
      return (
        <VStack padding={4} gap={3} paddingBlockStart={10}>
          <Banner status="error" title="Нет доступа" description="Эта учётная запись не привязана к студии." collapsible={false} />
          <Button label="Выйти" variant="secondary" onClick={() => void logout()} />
        </VStack>
      );
    return <ErrorState message={ctx.error.message} onRetry={() => void ctx.refetch()} />;
  }

  return (
    <VStack gap={4} padding={4} className="mx-auto w-full max-w-[720px]">
      <HStack justify="between" vAlign="center" gap={2}>
        <VStack>
          <Heading level={1}>{ctx.data.tenant.name}</Heading>
          <Text type="supporting">{ctx.data.tenant.status === 'live' ? 'Работает' : 'Образец (уведомления не отправляются)'}</Text>
        </VStack>
        <Button label="Выйти" variant="ghost" onClick={() => void logout()} />
      </HStack>
      <HStack gap={1} role="tablist" aria-label="Разделы" isScrollable>
        {TABS.map(([k, label]) => (
          <Button key={k} label={label} variant={tab === k ? 'primary' : 'ghost'} role="tab" aria-selected={tab === k} onClick={() => setParams({ tab: k })} />
        ))}
      </HStack>
      {tab === 'bookings' && <BookingsTab ctx={ctx.data} />}
      {tab === 'stats' && <StatsTab ctx={ctx.data} />}
      {tab === 'gallery' && <GalleryTab ctx={ctx.data} />}
      {tab === 'assistant' && <AssistantChat client={() => ownerClient(studio.slug)} slug={studio.slug} mode="owner" hints={['Сколько машин приехало за неделю?', 'Сколько получили денег за месяц?', 'Какие записи завтра?']} />}
      {tab === 'settings' && <SettingsTab ctx={ctx.data} />}
    </VStack>
  );
}
