import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { rub, plural } from '../../lib/format';
import { PERIODS, periodRange, type PeriodKey } from '../../shared/periods';
import { ErrorState, ListSkeleton } from '../../components/States';
import { getStats, type OwnerContext } from './ownerApi';

const SHOWN: PeriodKey[] = ['today', 'week', 'month'];

/** All numbers come from one SQL function in the studio's timezone — the same one the AI assistant reads. */
export function StatsTab({ ctx }: { ctx: OwnerContext }) {
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const [p, setP] = useState<PeriodKey>('week');
  const { from, to } = periodRange(p, tz);
  const q = useQuery({ queryKey: ['owner', slug, 'stats', from, to], queryFn: () => getStats(slug, from, to) });

  return (
    <VStack gap={4}>
      <HStack gap={2}>
        {SHOWN.map((k) => (
          <Button key={k} label={PERIODS[k].label} variant={p === k ? 'primary' : 'secondary'} aria-pressed={p === k} onClick={() => setP(k)} />
        ))}
      </HStack>
      <Text type="supporting">Период: {from} — {to} (часовой пояс студии: {tz})</Text>
      {q.isPending && <ListSkeleton rows={4} />}
      {q.isError && <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />}
      {q.isSuccess && (
        <VStack gap={3} as="dl" className="m-0">
          <Metric title="Приехали" value={`${q.data.arrivals} ${plural(q.data.arrivals, 'машина', 'машины', 'машин')}`} hint="Подтверждённые и выполненные записи, время которых попало в период." />
          <Metric title="Выполнено работ" value={`${q.data.completed} на ${rub(q.data.completed_value_cents)}`} hint="Записи, отмеченные выполненными в этот период, по их цене." />
          <Metric title="Получено денег" value={rub(q.data.received_cents)} hint={`Оплаты ${rub(q.data.payments_cents)} минус возвраты ${rub(q.data.refunds_cents)}, внесённые в период.`} />
          <Metric title="Ещё не подтверждено" value={`${q.data.scheduled_count} на ${rub(q.data.scheduled_value_cents)}`} hint="Новые записи ждут подтверждения. Это план, а не выручка." />
        </VStack>
      )}
    </VStack>
  );
}

function Metric({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <VStack gap={1} className="rounded-2xl border border-border bg-surface p-4">
      <dt><Text type="label" color="secondary">{title}</Text></dt>
      <dd className="m-0"><Heading level={2}>{value}</Heading></dd>
      <dd className="m-0"><Text type="supporting">{hint}</Text></dd>
    </VStack>
  );
}
