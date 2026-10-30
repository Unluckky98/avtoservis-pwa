import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { cancelMyBooking, getMyBooking } from '../../lib/api';
import { clearToken, readToken } from '../../lib/tenant';
import { dateLabel, duration, rub, timeLabel } from '../../lib/format';
import { downloadIcs } from '../../lib/ics';
import { turnOnReminder } from '../../lib/push';
import { useStudio } from '../../app/StudioContext';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/States';

const STATUS: Record<string, string> = { booked: 'Ожидает подтверждения', accepted: 'Подтверждена', done: 'Выполнена', cancelled: 'Отменена', no_show: 'Не приехали' };

export function MyBookingPage() {
  void useParams;
  const studio = useStudio();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [token, setToken] = useState(() => readToken(studio.slug));
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<{ status: 'success' | 'info' | 'warning' | 'error'; text: string } | null>(null);

  const q = useQuery({ queryKey: ['my-booking', studio.slug, token], queryFn: () => getMyBooking(token!), enabled: !!token, refetchOnWindowFocus: true });
  const cancel = useMutation({
    mutationFn: () => cancelMyBooking(token!),
    onSuccess: () => {
      setConfirm(false);
      setNote({ status: 'success', text: 'Запись отменена.' });
      void qc.invalidateQueries({ queryKey: ['my-booking'] });
      void qc.invalidateQueries({ queryKey: ['availability'] });
    },
    onError: (e) => {
      setConfirm(false);
      setNote({ status: 'error', text: e.message });
    },
  });

  return (
    <VStack gap={4} padding={4} paddingBlockStart={8}>
      <Heading level={1}>Моя запись</Heading>

      {!token && (
        <EmptyState
          title="Записей на этом устройстве нет"
          text="Когда вы запишетесь, она появится здесь — регистрация не нужна."
          action={<Button label="Записаться" variant="primary" onClick={() => nav('/?book=new')} />}
        />
      )}

      {token && q.isPending && <ListSkeleton rows={2} />}
      {token && q.isError && <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />}

      {token && q.isSuccess && q.data === null && (
        <EmptyState
          title="Запись не найдена"
          text="Возможно, ссылка устарела."
          action={<Button label="Убрать с этого устройства" variant="secondary" onClick={() => { clearToken(studio.slug); setToken(null); }} />}
        />
      )}

      {q.isSuccess && q.data && (
        <>
          {note && <Banner status={note.status} title={note.text} collapsible={false} isDismissable onDismiss={() => setNote(null)} />}
          <VStack gap={2} className="rounded-2xl border border-border bg-surface p-4">
            <Text type="label" color="accent">{STATUS[q.data.booking.status] ?? q.data.booking.status}</Text>
            <Heading level={2}>{q.data.booking.service_name}</Heading>
            <Text>{dateLabel(q.data.booking.starts_at, studio.timezone)}, {timeLabel(q.data.booking.starts_at, studio.timezone)}</Text>
            <Text type="supporting">
              {duration(q.data.booking.duration_minutes)} · {rub(q.data.booking.price_cents)}
              {q.data.booking.car ? ` · ${q.data.booking.car}` : ''}
            </Text>
            {studio.address && <Text type="supporting">{studio.address}</Text>}
          </VStack>

          {studio.preview && <Banner status="info" title="Образец студии" description="Напоминания здесь не отправляются." collapsible={false} />}

          {['booked', 'accepted'].includes(q.data.booking.status) && (
            <VStack gap={2}>
              <Button label="Добавить в календарь (.ics)" variant="secondary" onClick={() => downloadIcs(q.data!.booking, studio)} width="100%" />
              {!q.data.reminder && (
                <Button
                  label="Напомнить за сутки"
                  variant="secondary"
                  width="100%"
                  clickAction={async () => {
                    try {
                      const r = await turnOnReminder(token!);
                      setNote({ status: r.state === 'enabled' ? 'success' : 'info', text: r.message });
                      if (r.state === 'enabled') void qc.invalidateQueries({ queryKey: ['my-booking'] });
                    } catch (e) {
                      setNote({ status: 'error', text: e instanceof Error ? e.message : 'Не удалось включить напоминание' });
                    }
                  }}
                />
              )}
              {q.data.reminder && <Text type="supporting">Напоминание включено.</Text>}
              {studio.phone && <Button label="Позвонить в студию" variant="ghost" href={`tel:${studio.phone.replace(/[^0-9+]/g, '')}`} width="100%" />}
              {q.data.can_cancel ? (
                <Button label="Отменить запись" variant="destructive" onClick={() => setConfirm(true)} width="100%" />
              ) : (
                <Text type="supporting">Отменить онлайн можно не позднее чем за {q.data.cancel_before_hours} ч до начала. Позвоните в студию.</Text>
              )}
            </VStack>
          )}
          <Button label="Новая запись" variant="ghost" onClick={() => nav('/?book=new')} />
        </>
      )}

      <AlertDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title="Отменить запись?"
        description="Время освободится для других клиентов. Это действие нельзя отменить."
        actionLabel="Отменить запись"
        cancelLabel="Оставить"
        isActionLoading={cancel.isPending}
        onAction={() => cancel.mutate()}
      />
    </VStack>
  );
}
