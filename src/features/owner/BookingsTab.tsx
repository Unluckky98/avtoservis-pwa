import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { addDaysKey, dateLabel, duration, rub, timeLabel, todayIn } from '../../lib/format';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/States';
import {
  addPayment, blockResource, cancelOwnerBooking, closeDay, createOwnerBooking, getBookings, moveBooking, reopenDay, setStatus, unblock,
  type OwnerBooking, type OwnerContext,
} from './ownerApi';
import { LabeledInput, LabeledSelect, STATUS_LABEL, dayRange, isoToLocalInput, localToIso } from './shared';

export function BookingsTab({ ctx }: { ctx: OwnerContext }) {
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const qc = useQueryClient();
  const [day, setDay] = useState(() => todayIn(tz));
  const [open, setOpen] = useState<OwnerBooking | null>(null);
  const [creating, setCreating] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const range = dayRange(day, tz);
  const key = ['owner', slug, 'bookings', day];
  const q = useQuery({ queryKey: key, queryFn: () => getBookings(slug, range.from, range.to) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['owner', slug, 'bookings'] });
    void qc.invalidateQueries({ queryKey: ['owner', slug, 'stats'] });
    void qc.invalidateQueries({ queryKey: ['owner', slug, 'context'] });
  };
  const isOff = ctx.days_off.some((d) => d.day === day);
  const dayMut = useMutation({
    mutationFn: () => (isOff ? reopenDay(slug, day) : closeDay(slug, day, '')),
    onSuccess: (r: any) => {
      setNote(isOff ? 'День снова открыт для записи.' : `День закрыт для новых записей.${r.existing_bookings ? ` Уже есть записей: ${r.existing_bookings} — они сохранены.` : ''}`);
      refresh();
    },
    onError: (e) => setNote(e.message),
  });
  const unblockMut = useMutation({ mutationFn: (id: string) => unblock(slug, id), onSuccess: refresh, onError: (e) => setNote(e.message) });

  return (
    <VStack gap={4}>
      <HStack gap={2} vAlign="center" justify="between">
        <Button label="←" variant="secondary" onClick={() => setDay(addDaysKey(day, -1))} tooltip="Предыдущий день" />
        <VStack hAlign="center">
          <Text weight="semibold">{dateLabel(range.from, tz)}</Text>
          {day !== todayIn(tz) && <Button label="Сегодня" variant="ghost" size="sm" onClick={() => setDay(todayIn(tz))} />}
        </VStack>
        <Button label="→" variant="secondary" onClick={() => setDay(addDaysKey(day, 1))} tooltip="Следующий день" />
      </HStack>

      <HStack gap={2} wrap="wrap">
        <Button label="Новая запись" variant="primary" onClick={() => setCreating(true)} />
        <Button label="Заблокировать бокс" variant="secondary" onClick={() => setBlocking(true)} />
        <Button label={isOff ? 'Открыть день' : 'Закрыть день'} variant="secondary" clickAction={async () => void (await dayMut.mutateAsync().catch(() => {}))} />
      </HStack>
      {isOff && <Banner status="warning" title="День закрыт для новых записей" collapsible={false} />}
      {note && <Banner status="info" title={note} isDismissable onDismiss={() => setNote(null)} collapsible={false} />}

      {q.isPending && <ListSkeleton rows={3} />}
      {q.isError && <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />}
      {q.isSuccess && q.data.bookings.length === 0 && q.data.blocks.length === 0 && <EmptyState title="На этот день записей нет" text="Новые записи клиентов появятся здесь." />}

      {q.isSuccess && (
        <VStack gap={2} as="ul" className="m-0 p-0 list-none">
          {q.data.bookings.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => setOpen(b)} className={`w-full rounded-2xl border border-border bg-surface p-4 text-left ${b.status === 'cancelled' ? 'opacity-55' : ''}`}>
                <HStack justify="between" gap={3}>
                  <Text weight="semibold" hasTabularNumbers>{timeLabel(b.starts_at, tz)}–{timeLabel(b.ends_at, tz)}</Text>
                  <Text type="label" color="accent">{STATUS_LABEL[b.status] ?? b.status}</Text>
                </HStack>
                <Text>{b.service_name} · {b.customer_name}</Text>
                <Text type="supporting">{b.resource}{b.car ? ` · ${b.car}` : ''} · {rub(b.price_cents)}{b.paid_cents ? ` (оплачено ${rub(b.paid_cents)})` : ''}</Text>
              </button>
            </li>
          ))}
          {q.data.blocks.map((b) => (
            <li key={b.id} className="rounded-2xl border border-dashed border-border p-4">
              <HStack justify="between" gap={3} vAlign="center">
                <VStack>
                  <Text weight="semibold">Блок: {b.resource}</Text>
                  <Text type="supporting">{timeLabel(b.from, tz)}–{timeLabel(b.to, tz)}{b.reason ? ` · ${b.reason}` : ''}</Text>
                </VStack>
                <Button label="Снять" variant="ghost" clickAction={async () => void (await unblockMut.mutateAsync(b.id).catch(() => {}))} />
              </HStack>
            </li>
          ))}
        </VStack>
      )}

      <DetailSheet ctx={ctx} booking={open} onClose={() => setOpen(null)} onChanged={refresh} />
      <CreateSheet ctx={ctx} open={creating} day={day} onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />
      <BlockSheet ctx={ctx} open={blocking} day={day} onClose={() => setBlocking(false)} onDone={() => { setBlocking(false); refresh(); }} />
    </VStack>
  );
}

function DetailSheet({ ctx, booking, onClose, onChanged }: { ctx: OwnerContext; booking: OwnerBooking | null; onClose: () => void; onChanged: () => void }) {
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const [mode, setMode] = useState<'view' | 'move' | 'pay'>('view');
  const [when, setWhen] = useState('');
  const [resId, setResId] = useState('');
  const [kind, setKind] = useState<'payment' | 'refund'>('payment');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [payKey, setPayKey] = useState(() => `pay-${crypto.randomUUID()}`);

  const b = booking;
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try {
      await fn();
      onChanged();
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    }
  };
  const active = b && ['booked', 'accepted'].includes(b.status);

  return (
    <BottomSheet
      isOpen={!!b}
      onOpenChange={(o) => { if (!o) { setMode('view'); setError(null); onClose(); } }}
      label="Запись клиента"
      height="tall"
      purpose={mode === 'view' ? 'info' : 'form'}
    >
      {b && (
        <VStack gap={4}>
          <Heading level={2}>{b.service_name}</Heading>
          <Text>{dateLabel(b.starts_at, tz)}, {timeLabel(b.starts_at, tz)}–{timeLabel(b.ends_at, tz)} · {b.resource}</Text>
          <Text type="label" color="accent">{STATUS_LABEL[b.status] ?? b.status}</Text>
          <VStack gap={1}>
            <Text>{b.customer_name}{b.car ? ` · ${b.car}` : ''}</Text>
            <a className="underline" href={`tel:${b.customer_phone}`}>{b.customer_phone}</a>
            <Text type="supporting">Цена {rub(b.price_cents)} · оплачено {rub(b.paid_cents)} · остаток {rub(Math.max(b.price_cents - b.paid_cents, 0))}</Text>
          </VStack>
          {error && <Banner status="error" title={error} collapsible={false} />}

          {mode === 'view' && (
            <VStack gap={2}>
              {b.status === 'booked' && <Button label="Подтвердить" variant="primary" clickAction={() => run(() => setStatus(slug, b.id, 'accepted'), onClose)} width="100%" />}
              {b.status === 'accepted' && <Button label="Отметить выполненной" variant="primary" clickAction={() => run(() => setStatus(slug, b.id, 'done'), onClose)} width="100%" />}
              {active && <Button label="Перенести" variant="secondary" onClick={() => { setWhen(isoToLocalInput(b.starts_at, tz)); setResId(b.resource_id); setMode('move'); }} width="100%" />}
              {b.status !== 'cancelled' && <Button label="Оплата / возврат" variant="secondary" onClick={() => { setPayKey(`pay-${crypto.randomUUID()}`); setAmount(''); setMode('pay'); }} width="100%" />}
              {b.status !== 'cancelled' && b.status !== 'done' && <Button label="Отменить запись" variant="destructive" onClick={() => setConfirmCancel(true)} width="100%" />}
            </VStack>
          )}

          {mode === 'move' && (
            <VStack gap={3}>
              <LabeledInput label="Новое время" type="datetime-local" value={when} onChange={setWhen} step={900} />
              <LabeledSelect label="Бокс" value={resId} onChange={setResId} options={ctx.resources.filter((r) => r.active !== false).map((r) => ({ value: r.id, label: r.name }))} />
              <HStack gap={2}>
                <Button label="Назад" variant="ghost" width={104} onClick={() => setMode('view')} />
                <Button label="Перенести" variant="primary" width="100%" isDisabled={!when} clickAction={() => run(() => moveBooking(slug, b.id, localToIso(when, tz), resId || null), onClose)} />
              </HStack>
            </VStack>
          )}

          {mode === 'pay' && (
            <VStack gap={3}>
              <LabeledSelect label="Операция" value={kind} onChange={(v) => setKind(v as 'payment' | 'refund')} options={[{ value: 'payment', label: 'Оплата' }, { value: 'refund', label: 'Возврат' }]} />
              <TextInput label="Сумма, ₽" value={amount} onChange={setAmount} />
              <LabeledSelect label="Способ" value={method} onChange={setMethod} options={[{ value: 'cash', label: 'Наличные' }, { value: 'card', label: 'Карта' }, { value: 'transfer', label: 'Перевод' }, { value: 'other', label: 'Другое' }]} />
              <HStack gap={2}>
                <Button label="Назад" variant="ghost" width={104} onClick={() => setMode('view')} />
                <Button
                  label="Сохранить"
                  variant="primary"
                  width="100%"
                  isDisabled={!(Number(amount.replace(',', '.')) > 0)}
                  clickAction={() => run(() => addPayment(slug, { id: b.id, kind, cents: Math.round(Number(amount.replace(',', '.')) * 100), method, note: '', key: payKey }), onClose)}
                />
              </HStack>
            </VStack>
          )}

          <AlertDialog
            isOpen={confirmCancel}
            onOpenChange={setConfirmCancel}
            title="Отменить запись?"
            description={b.paid_cents > 0 ? `Клиент уже заплатил ${rub(b.paid_cents)}. Верните деньги отдельной операцией «Возврат».` : 'Время освободится. Клиент увидит отмену в «Моей записи».'}
            actionLabel="Отменить запись"
            cancelLabel="Оставить"
            onAction={() => void run(() => cancelOwnerBooking(slug, b.id), () => { setConfirmCancel(false); onClose(); })}
          />
        </VStack>
      )}
    </BottomSheet>
  );
}

function CreateSheet({ ctx, open, day, onClose, onDone }: { ctx: OwnerContext; open: boolean; day: string; onClose: () => void; onDone: () => void }) {
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const services = ctx.services.filter((s) => s.active);
  const [svc, setSvc] = useState('');
  const [when, setWhen] = useState('');
  const [res, setRes] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [car, setCar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => `own-${crypto.randomUUID()}`);

  const svcId = svc || services[0]?.id || '';
  const whenVal = when || `${day}T10:00`;

  return (
    <BottomSheet isOpen={open} onOpenChange={(o) => !o && onClose()} label="Новая запись" height="tall" purpose="form">
      <VStack gap={3}>
        <Heading level={2}>Новая запись</Heading>
        {error && <Banner status="error" title={error} collapsible={false} />}
        <LabeledSelect label="Услуга" value={svcId} onChange={setSvc} options={services.map((s) => ({ value: s.id, label: `${s.name} — ${rub(s.price_cents)}, ${duration(s.duration_minutes)}` }))} />
        <LabeledInput label="Время начала" type="datetime-local" value={whenVal} onChange={setWhen} step={900} />
        <LabeledSelect label="Бокс" value={res} onChange={setRes} options={[{ value: '', label: 'Любой свободный' }, ...ctx.resources.filter((r) => r.active !== false).map((r) => ({ value: r.id, label: r.name }))]} />
        <TextInput label="Имя клиента" value={name} onChange={setName} isRequired />
        <TextInput label="Телефон" value={phone} onChange={setPhone} isRequired />
        <TextInput label="Автомобиль" value={car} onChange={setCar} isOptional />
        <HStack gap={2}>
          <Button label="Отмена" variant="ghost" width={104} onClick={onClose} />
          <Button
            label="Создать"
            variant="primary"
            width="100%"
            clickAction={async () => {
              setError(null);
              try {
                await createOwnerBooking(slug, { serviceId: svcId, startsAt: localToIso(whenVal, tz), name: name.trim(), phone: phone.replace(/[^0-9+]/g, ''), car: car.trim(), resourceId: res || null, key });
                setKey(`own-${crypto.randomUUID()}`);
                setName(''); setPhone(''); setCar('');
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Ошибка');
              }
            }}
          />
        </HStack>
      </VStack>
    </BottomSheet>
  );
}

function BlockSheet({ ctx, open, day, onClose, onDone }: { ctx: OwnerContext; open: boolean; day: string; onClose: () => void; onDone: () => void }) {
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const resources = ctx.resources.filter((r) => r.active !== false);
  const [res, setRes] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <BottomSheet isOpen={open} onOpenChange={(o) => !o && onClose()} label="Блокировка бокса" height="tall" purpose="form">
      <VStack gap={3}>
        <Heading level={2}>Заблокировать бокс</Heading>
        <Text type="supporting">Клиенты не смогут записаться на это время (например, ремонт или обед).</Text>
        {error && <Banner status="error" title={error} collapsible={false} />}
        <LabeledSelect label="Бокс" value={res || resources[0]?.id || ''} onChange={setRes} options={resources.map((r) => ({ value: r.id, label: r.name }))} />
        <LabeledInput label="С" type="datetime-local" value={from || `${day}T09:00`} onChange={setFrom} step={900} />
        <LabeledInput label="До" type="datetime-local" value={to || `${day}T12:00`} onChange={setTo} step={900} />
        <TextInput label="Причина" value={reason} onChange={setReason} isOptional />
        <HStack gap={2}>
          <Button label="Отмена" variant="ghost" width={104} onClick={onClose} />
          <Button
            label="Заблокировать"
            variant="primary"
            width="100%"
            clickAction={async () => {
              setError(null);
              try {
                await blockResource(slug, res || resources[0]!.id, localToIso(from || `${day}T09:00`, tz), localToIso(to || `${day}T12:00`, tz), reason);
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Ошибка');
              }
            }}
          />
        </HStack>
      </VStack>
    </BottomSheet>
  );
}
