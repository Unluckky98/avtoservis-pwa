import { useSearchParams } from 'react-router-dom';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Phone, MapPin, ChatCircleDots } from '@phosphor-icons/react';
import { useStudio } from '../../app/StudioContext';
import { Reveal } from '../../components/Reveal';
import { WEEKDAY_NAMES, rub } from '../../lib/format';

export function HomePage() {
  const s = useStudio();
  const [, setParams] = useSearchParams();
  const openBooking = () => setParams({ book: 'new' });

  return (
    <VStack gap={6}>
      <header className="hero" style={{ height: 'min(68svh, 560px)' }}>
        {s.hero_url ? <img src={s.hero_url} alt={s.hero_alt ?? s.name} fetchPriority="high" /> : <span className="block h-full bg-surface" aria-hidden="true" />}
        <button type="button" className="hero-cta glass glass-accent rounded-full min-h-[56px] text-lg font-semibold text-white" onClick={openBooking}>
          Записаться
        </button>
      </header>

      <VStack gap={2} paddingInline={4}>
        <Heading level={1} type="display-3">
          {s.name}
        </Heading>
        {s.tagline && <Text type="large" color="secondary">{s.tagline}</Text>}
      </VStack>

      <Reveal className="px-4">
        <VStack gap={3}>
          <Heading level={2}>Запись в студию</Heading>
          {s.description && <Text color="secondary">{s.description}</Text>}
        </VStack>
      </Reveal>

      <Reveal className="px-4">
        <VStack gap={3} as="ul" className="m-0 p-0 list-none">
          {s.cards.map((c) => (
            <li key={c.position} className="rounded-2xl border border-border bg-surface p-4">
              <Heading level={3}>{c.title}</Heading>
              <Text color="secondary">{c.body}</Text>
            </li>
          ))}
        </VStack>
      </Reveal>

      {s.services.length > 0 && (
        <Reveal className="px-4">
          <VStack gap={3}>
            <Heading level={2}>Популярные услуги</Heading>
            <VStack gap={2} as="ul" className="m-0 p-0 list-none">
              {s.services.slice(0, 3).map((x) => (
                <li key={x.id}>
                  <button type="button" className="w-full text-left rounded-2xl border border-border bg-surface p-4 min-h-[60px]" onClick={() => setParams({ book: x.id })}>
                    <HStack justify="between" gap={3}>
                      <Text weight="semibold">{x.name}</Text>
                      <Text hasTabularNumbers>{rub(x.price_cents)}</Text>
                    </HStack>
                  </button>
                </li>
              ))}
            </VStack>
          </VStack>
        </Reveal>
      )}

      {s.gallery.length > 0 && (
        <Reveal>
          <VStack gap={3}>
            <Heading level={2} className="px-4">Наши работы</Heading>
            <ul tabIndex={0} className="m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2" aria-label="Фотографии работ">
              {s.gallery.map((g) => (
                <li key={g.id} className="w-[78%] max-w-[340px] shrink-0 snap-center">
                  <figure className="m-0">
                    <img src={g.image_url} alt={g.caption ?? 'Фото работы'} loading="lazy" className="aspect-[4/3] w-full rounded-2xl object-cover" />
                    {g.caption && <figcaption className="mt-1 text-sm text-white/70">{g.caption}</figcaption>}
                  </figure>
                </li>
              ))}
            </ul>
          </VStack>
        </Reveal>
      )}

      <Reveal className="px-4">
        <VStack gap={3}>
          <Heading level={2}>Контакты</Heading>
          {s.address && (
            <HStack gap={2} vAlign="center">
              <MapPin size={20} aria-hidden="true" />
              <a className="underline" href={`https://yandex.ru/maps/?text=${encodeURIComponent(s.address)}`} target="_blank" rel="noopener noreferrer">{s.address}</a>
            </HStack>
          )}
          {s.phone && (
            <HStack gap={2} vAlign="center">
              <Phone size={20} aria-hidden="true" />
              <a className="underline" href={`tel:${s.phone.replace(/[^0-9+]/g, '')}`}>{s.phone}</a>
            </HStack>
          )}
          <Button label="Спросить помощника" variant="secondary" icon={<ChatCircleDots size={20} aria-hidden="true" />} onClick={() => setParams({ chat: '1' })} />
          <VStack gap={1} as="ul" className="m-0 p-0 list-none" aria-label="График работы">
            {WEEKDAY_NAMES.map((n, i) => {
              const h = s.hours.find((x) => x.weekday === i + 1);
              return (
                <HStack key={n} justify="between" as="li">
                  <Text as="span" color="secondary">{n}</Text>
                  <Text as="span" hasTabularNumbers>{h ? `${h.opens}–${h.closes}` : 'выходной'}</Text>
                </HStack>
              );
            })}
          </VStack>
        </VStack>
      </Reveal>
    </VStack>
  );
}
