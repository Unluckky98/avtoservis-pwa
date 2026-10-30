import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { getStudio } from '../lib/api';
import { slugFromPath } from '../lib/tenant';
import { StudioContext, useStudio } from './StudioContext';
import { StudioTheme } from './StudioTheme';
import { GlassNav } from '../components/GlassNav';
import { ErrorState, Loading } from '../components/States';
import { HomePage } from '../features/client/HomePage';
import { ServicesPage } from '../features/client/ServicesPage';
import { MyBookingPage } from '../features/client/MyBookingPage';
import { BookingSheet } from '../features/client/BookingSheet';
import { ChatSheet } from '../features/client/ChatSheet';

const OwnerApp = lazy(() => import('../features/owner/OwnerApp'));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function ClientLayout() {
  const [params, setParams] = useSearchParams();
  const book = params.get('book');
  const studio = useStudio();
  return (
    <>
      <a href="#main" className="skip-link">К содержимому</a>
      <main id="main" className="app-main mx-auto w-full max-w-[560px]">
        <Outlet />
      </main>
      <GlassNav />
      <BookingSheet
        open={book !== null}
        serviceId={book && book !== 'new' ? book : null}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete('book');
          setParams(next);
        }}
        key={studio.slug}
      />
      <ChatSheet
        open={params.get('chat') !== null}
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete('chat');
          setParams(next);
        }}
      />
    </>
  );
}

function StudioGate({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ['studio', slug], queryFn: () => getStudio(slug), staleTime: 60_000 });
  if (q.isPending)
    return (
      <StudioTheme>
        <Loading label="Загружаем студию…" />
      </StudioTheme>
    );
  if (q.isError)
    return (
      <StudioTheme>
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      </StudioTheme>
    );
  if (!q.data)
    return (
      <StudioTheme>
        <VStack padding={6} gap={2} hAlign="center">
          <Heading level={1}>Студия не найдена</Heading>
          <Text color="secondary">Проверьте адрес ссылки.</Text>
        </VStack>
      </StudioTheme>
    );
  document.title = q.data.name;
  return (
    <StudioTheme accent={q.data.accent}>
      <StudioContext.Provider value={q.data}>
        <Routes>
          <Route path="owner/*" element={<Suspense fallback={<Loading />}><OwnerApp /></Suspense>} />
          <Route element={<ClientLayout />}>
            <Route index element={<HomePage />} />
            <Route path="services" element={<ServicesPage />} />
            <Route path="my" element={<MyBookingPage />} />
            <Route path="*" element={<Navigate to="." replace />} />
          </Route>
        </Routes>
      </StudioContext.Provider>
    </StudioTheme>
  );
}

export function App() {
  const slug = slugFromPath();
  return (
    <QueryClientProvider client={queryClient}>
      {slug ? (
        <BrowserRouter basename={`/s/${slug}`}>
          <StudioGate slug={slug} />
        </BrowserRouter>
      ) : (
        <StudioTheme>
          <VStack padding={6} gap={2} hAlign="center">
            <Heading level={1}>Онлайн-запись</Heading>
            <Text color="secondary">Откройте ссылку вашей студии: /s/название-студии/</Text>
          </VStack>
        </StudioTheme>
      )}
    </QueryClientProvider>
  );
}
