import { Link, useSearchParams } from 'react-router-dom';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Phone, MapPin, ChatCircleDots, ArrowUpRight, Wrench, Clock, Tag, UserCircle } from '@phosphor-icons/react';
import { useStudio } from '../../app/StudioContext';
import { Reveal } from '../../components/Reveal';
import { WEEKDAY_NAMES, rub } from '../../lib/format';

function Tile({ icon, value, label, small }: { icon: React.ReactNode; value: string; label: string; small?: boolean }) {
  return (
    <article className="tile card-glass">
      <span className={`tile-value${small ? ' is-small' : ''}`}>
        {icon}
        {value}
      </span>
      <span className="tile-label">{label}</span>
    </article>
  );
}

/** Opening hours of today in the studio's own time zone, e.g. "10:00–21:00", or null on a day off. */
function todayHours(s: { timezone: string; hours: { weekday: number; opens: string; closes: string }[] }) {
  const short = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: s.timezone });
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(short) + 1;
  const h = s.hours.find((x) => x.weekday === weekday);
  return h ? `${h.opens}–${h.closes}` : null;
}

export function HomePage() {
  const s = useStudio();
  const [, setParams] = useSearchParams();
  const openBooking = () => setParams({ book: 'new' });
  const minPrice = s.services.length ? Math.min(...s.services.map((x) => x.price_cents)) : null;
  const today = todayHours(s);

  return (
    <VStack gap={5} paddingInline={4}>
      <header className="top-bar">
        {s.logo_url ? <img src={s.logo_url} alt={s.name} /> : <Text weight="semibold">{s.name}</Text>}
        <Link to="my" className="icon-btn" aria-label="Моя запись">
          <UserCircle size={28} aria-hidden="true" />
        </Link>
      </header>

      <section className="hero" style={{ height: 'min(38svh, 300px)' }} aria-label={s.name}>
        {s.hero_url ? <img src={s.hero_url} alt={s.hero_alt ?? s.name} fetchPriority="high" /> : <span className="block h-full bg-surface" aria-hidden="true" />}
        <button type="button" className="hero-cta glass" onClick={openBooking}>
          <span>Записаться</span>
          <ArrowUpRight size={22} aria-hidden="true" />
        </button>
      </section>

      <VStack gap={2}>
        <Heading level={1} type="display-3">
          {s.name}
        </Heading>
        {(s.tagline || s.description) && <Text type="large" color="secondary">{s.tagline || s.description}</Text>}
      </VStack>

      <section className="grid grid-cols-2 gap-3" aria-label="О студии">
        <Tile icon={<Wrench size={24} aria-hidden="true" />} value={String(s.services.length)} label="услуг в прайсе" />
        <Tile icon={<Clock size={24} aria-hidden="true" />} value={today ?? 'выходной'} small label={today ? 'работаем сегодня' : 'сегодня не работаем'} />
      </section>
      {minPrice !== null && (
        <article className="tile card-glass flex-row items-center justify-between">
          <span className="tile-value">
            <Tag size={24} aria-hidden="true" />от {rub(minPrice)}
          </span>
          <span className="tile-label">за услугу</span>
        </article>
      )}

      <Reveal>
        <VStack gap={3} as="ul" className="m-0 p-0 list-none">
          {s.cards.map((c) => (
            <li key={c.position} className="card-glass p-4">
              <Heading level={3}>{c.title}</Heading>
              <Text color="secondary">{c.body}</Text>
            </li>
          ))}
        </VStack>
      </Reveal>

      {s.services.length > 0 && (
        <Reveal>
          <VStack gap={3}>
            <Heading level={2}>Популярные услуги</Heading>
            <VStack gap={2} as="ul" className="m-0 p-0 list-none">
              {s.services.slice(0, 3).map((x) => (
                <li key={x.id}>
                  <button type="button" className="card-glass w-full text-left p-4 min-h-[60px]" onClick={() => setParams({ book: x.id })}>
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
            <Heading level={2}>Наши работы</Heading>
            <ul tabIndex={0} className="m-0 -mx-4 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2" aria-label="Фотографии работ">
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

      <Reveal>
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
