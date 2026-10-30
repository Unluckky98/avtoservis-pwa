import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { ApiError, createBooking, getAvailability, type Booking, type Service } from '../../lib/api';
import { addDaysKey, dateLabel, dayKey, duration, rub, timeLabel, todayIn, weekdayShort } from '../../lib/format';
import { downloadIcs } from '../../lib/ics';
import { saveToken } from '../../lib/tenant';
import { useStudio } from '../../app/StudioContext';
import { ArrowUpRight } from '@phosphor-icons/react';
import { EmptyState, ErrorState } from '../../components/States';

type Step = 'service' | 'slot' | 'details' | 'done';
const WINDOW_DAYS = 14;

const PHONE_OK = /^\+?[0-9]{10,15}$/;
const normPhone = (s: string) => s.replace(/[^0-9+]/g, '');

export function BookingSheet({ open, serviceId, onClose }: { open: boolean; serviceId: string | null; onClose: () => void }) {
  const studio = useStudio();
  const nav = useNavigate();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>('service');
  const [svcId, setSvcId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [car, setCar] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ booking: Booking } | null>(null);
  const attempt = useRef<{ fp: string; key: string } | null>(null);
  const headRef = useRef<HTMLDivElement>(null);

  // Open fresh (or with the preselected service) every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    const known = serviceId && studio.services.some((s) => s.id === serviceId) ? serviceId : null;
    setSvcId(known);
    setStep(known ? 'slot' : 'service');
    setDay(null);
    setSlot(null);
    setError(null);
    setResult(null);
    setTouched(false);
  }, [open, serviceId, studio.services]);

  useEffect(() => {
    headRef.current?.focus({ preventScroll: true });
  }, [step, open]);

  const service: Service | undefined = studio.services.find((s) => s.id === svcId);
  const today = todayIn(studio.timezone);
  const to = addDaysKey(today, WINDOW_DAYS - 1);

  const avail = useQuery({
    queryKey: ['availability', studio.slug, svcId, today],
    queryFn: () => getAvailability(studio.slug, svcId!, today, to),
    enabled: open && step === 'slot' && !!svcId,
    staleTime: 15_000,
  });

  const byDay = useMemo(() => {
    const m = new Map<string, { start: string; available: boolean }[]>();
    for (const s of avail.data ?? []) {
      const k = dayKey(s.start, studio.timezone);
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
  }, [avail.data, studio.timezone]);

  const freeDays = useMemo(() => [...byDay.entries()].filter(([, v]) => v.some((s) => s.available)).map(([k]) => k).sort(), [byDay]);
  const activeDay = day && freeDays.includes(day) ? day : (freeDays[0] ?? null);

  const nameErr = name.trim().length < 2 ? 'Укажите имя' : null;
  const phoneErr = PHONE_OK.test(normPhone(phone)) ? null : 'Введите номер телефона полностью';
  const valid = !nameErr && !phoneErr;

  async function submit() {
    setTouched(true);
    setError(null);
    if (!valid || !service || !slot) return;
    const fp = [service.id, slot, normPhone(phone), name.trim().toLowerCase()].join('|');
    // Same data = same idempotency key, so a retry after a network failure can never double-book.
    if (attempt.current?.fp !== fp) attempt.current = { fp, key: `web-${crypto.randomUUID()}` };
    try {
      const r = await createBooking({ slug: studio.slug, serviceId: service.id, startsAt: slot, name: name.trim(), phone: normPhone(phone), car: car.trim(), key: attempt.current.key });
      saveToken(studio.slug, r.token);
      void qc.invalidateQueries({ queryKey: ['availability'] });
      void qc.invalidateQueries({ queryKey: ['my-booking'] });
      setResult({ booking: r.booking });
      setStep('done');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(e instanceof Error ? e.message : 'Ошибка');
      if (code === 'slot_taken' || code === 'slot_unavailable') {
        setSlot(null);
        setStep('slot');
        void avail.refetch();
      }
    }
  }

  const title = { service: 'Выберите услугу', slot: 'Дата и время', details: 'Ваш автомобиль', done: 'Вы записаны' }[step];
  const stepNo = { service: 1, slot: 2, details: 3, done: 4 }[step];

  return (
    <BottomSheet isOpen={open} onOpenChange={(o) => !o && onClose()} label="Запись в студию" height="tall" purpose={step === 'details' ? 'form' : 'info'}>
      <VStack gap={4}>
        <div ref={headRef} tabIndex={-1} className="outline-none">
          <Heading level={2}>{title}</Heading>
          <Text type="supporting">Шаг {stepNo} из 4</Text>
          <span className="step-bar mt-2" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => (
              <span key={n} data-on={n <= stepNo} />
            ))}
          </span>
          {step !== 'service' && step !== 'done' && service && (
            <Text type="supporting">
              {service.name} · {rub(service.price_cents)} · {duration(service.duration_minutes)}
            </Text>
          )}
        </div>

        {studio.preview && step !== 'done' && (
          <Banner status="info" title="Образец студии" description="Записи здесь демонстрационные, уведомления не отправляются." collapsible={false} />
        )}
        {error && <Banner status="error" title="Не удалось записаться" description={error} collapsible={false} />}

        {step === 'service' && (
          <VStack gap={2} as="ul" className="m-0 p-0 list-none">
            {studio.services.length === 0 && <EmptyState title="Услуг пока нет" text="Студия ещё не добавила услуги." />}
            {studio.services.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="card-glass w-full text-left p-4 min-h-[64px]"
                  onClick={() => {
                    setSvcId(s.id);
                    setStep('slot');
                  }}
                >
                  <HStack justify="between" gap={3} vAlign="start">
                    <VStack gap={1}>
                      <Text weight="semibold">{s.name}</Text>
                      <Text type="supporting">{duration(s.duration_minutes)}</Text>
                    </VStack>
                    <VStack gap={1} hAlign="end">
                      <Text weight="semibold" hasTabularNumbers>{rub(s.price_cents)}</Text>
                      <span className="inline-flex items-center gap-1 text-sm text-white/70">
                        Выбрать <ArrowUpRight size={16} aria-hidden="true" />
                      </span>
                    </VStack>
                  </HStack>
                </button>
              </li>
            ))}
          </VStack>
        )}

        {step === 'slot' && (
          <VStack gap={4}>
            {avail.isPending && (
              <VStack gap={2} aria-hidden="true">
                <Skeleton height={56} />
                <Skeleton height={120} />
              </VStack>
            )}
            {avail.isError && <ErrorState message={avail.error instanceof Error ? avail.error.message : 'Ошибка'} onRetry={() => void avail.refetch()} />}
            {avail.isSuccess && freeDays.length === 0 && (
              <EmptyState title="Свободных окон нет" text={`На ближайшие ${WINDOW_DAYS} дней всё занято. Позвоните в студию${studio.phone ? `: ${studio.phone}` : ''}.`} />
            )}
            {avail.isSuccess && freeDays.length > 0 && activeDay && (
              <>
                <HStack gap={2} isScrollable role="radiogroup" aria-label="День" className="pb-1">
                  {freeDays.map((k) => {
                    const first = byDay.get(k)![0]!.start;
                    const on = k === activeDay;
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setDay(k);
                          setSlot(null);
                        }}
                        className={`shrink-0 min-w-[64px] border px-3 py-2 text-center ${on ? 'chip-on' : 'card-glass !rounded-[18px]'}`}
                      >
                        <span className="block text-xs uppercase opacity-80">{weekdayShort(first, studio.timezone)}</span>
                        <span className="block text-lg font-semibold">{k.slice(8)}</span>
                      </button>
                    );
                  })}
                </HStack>
                <Text type="label">{dateLabel(byDay.get(activeDay)![0]!.start, studio.timezone)}</Text>
                <HStack gap={2} wrap="wrap" role="radiogroup" aria-label="Время">
                  {byDay.get(activeDay)!.map((s) => (
                    <button
                      key={s.start}
                      type="button"
                      role="radio"
                      aria-checked={slot === s.start}
                      disabled={!s.available}
                      onClick={() => setSlot(s.start)}
                      className={`min-w-[78px] min-h-[44px] rounded-[14px] border px-3 py-2 text-base ${
                        slot === s.start ? 'chip-on' : s.available ? 'card-glass !rounded-[14px]' : 'border-white/10 text-white/30 line-through'
                      }`}
                    >
                      {timeLabel(s.start, studio.timezone)}
                    </button>
                  ))}
                </HStack>
              </>
            )}
            <HStack gap={2}>
              {!serviceId && <Button label="Назад" variant="ghost" width={104} onClick={() => setStep('service')} />}
              <Button label="Далее" variant="primary" isDisabled={!slot} onClick={() => setStep('details')} width="100%" />
            </HStack>
          </VStack>
        )}

        {step === 'details' && service && slot && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <VStack gap={4}>
              <Text>
                {dateLabel(slot, studio.timezone)}, {timeLabel(slot, studio.timezone)}
              </Text>
              <TextInput label="Имя" value={name} onChange={setName} autoComplete="name" isRequired status={touched && nameErr ? { type: 'error', message: nameErr } : undefined} />
              <TextInput label="Телефон" value={phone} onChange={setPhone} autoComplete="tel" placeholder="+7 900 000-00-00" isRequired status={touched && phoneErr ? { type: 'error', message: phoneErr } : undefined} />
              <TextInput label="Автомобиль" value={car} onChange={setCar} placeholder="Марка и модель" isOptional />
              <Text type="supporting">Регистрация не нужна: запись сохранится на этом устройстве, по ссылке вы сможете её отменить.</Text>
              <HStack gap={2}>
                <Button label="Назад" variant="ghost" width={104} onClick={() => setStep('slot')} />
                <Button label="Записаться" variant="primary" type="submit" clickAction={submit} width="100%" />
              </HStack>
            </VStack>
          </form>
        )}

        {step === 'done' && result && (
          <VStack gap={4}>
            <Banner status="success" title="Запись создана" description={`${result.booking.service_name} · ${dateLabel(result.booking.starts_at, studio.timezone)}, ${timeLabel(result.booking.starts_at, studio.timezone)}`} collapsible={false} />
            <Text type="supporting">Статус можно посмотреть и отменить в разделе «Моя запись».{studio.address ? ` Адрес: ${studio.address}.` : ''}</Text>
            <Button label="Моя запись" variant="primary" onClick={() => nav('/my')} width="100%" />
            <Button label="Добавить в календарь (.ics)" variant="secondary" onClick={() => downloadIcs(result.booking, studio)} width="100%" />
            <Button label="Закрыть" variant="ghost" onClick={onClose} width="100%" />
          </VStack>
        )}
      </VStack>
    </BottomSheet>
  );
}
