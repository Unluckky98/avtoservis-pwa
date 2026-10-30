import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { WEEKDAY_NAMES } from '../../lib/format';
import { table, tenantId, type OwnerContext } from './ownerApi';
import { LabeledInput } from './shared';

const num = (s: string, d: number) => (Number.isFinite(Number(s)) && s.trim() !== '' ? Math.trunc(Number(s)) : d);

export function SettingsTab({ ctx }: { ctx: OwnerContext }) {
  const slug = ctx.tenant.slug;
  const qc = useQueryClient();
  const t = ctx.tenant;
  const [f, setF] = useState({
    name: t.name, tagline: t.tagline ?? '', description: t.description ?? '', address: t.address ?? '', phone: t.phone ?? '',
    step: String(t.slot_step_minutes), lead: String(t.lead_time_minutes), cancel: String(t.cancel_before_hours), horizon: String(t.max_horizon_days),
  });
  const [msg, setMsg] = useState<{ s: 'success' | 'error'; t: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['owner', slug, 'context'] });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setMsg(null);
    try {
      await table(slug, (c) =>
        c.from('tenants').update({
          name: f.name.trim(), tagline: f.tagline.trim(), description: f.description.trim(), address: f.address.trim() || null, phone: f.phone.trim() || null,
          slot_step_minutes: num(f.step, 30), lead_time_minutes: num(f.lead, 120), cancel_before_hours: num(f.cancel, 24), max_horizon_days: num(f.horizon, 60), updated_at: new Date().toISOString(),
        }).eq('slug', slug),
      );
      await refresh();
      void qc.invalidateQueries({ queryKey: ['studio', slug] });
      setMsg({ s: 'success', t: 'Сохранено.' });
    } catch (e) {
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  };

  return (
    <VStack gap={6}>
      {msg && <Banner status={msg.s} title={msg.t} isDismissable onDismiss={() => setMsg(null)} collapsible={false} />}
      <VStack gap={3}>
        <Heading level={2}>О студии</Heading>
        <TextInput label="Название" value={f.name} onChange={set('name')} />
        <TextInput label="Подзаголовок" value={f.tagline} onChange={set('tagline')} />
        <TextInput label="Описание" value={f.description} onChange={set('description')} />
        <TextInput label="Адрес" value={f.address} onChange={set('address')} />
        <TextInput label="Телефон" value={f.phone} onChange={set('phone')} />
        <Heading level={3}>Правила записи</Heading>
        <TextInput label="Шаг времени, мин" value={f.step} onChange={set('step')} />
        <TextInput label="Минимум до записи, мин" value={f.lead} onChange={set('lead')} />
        <TextInput label="Отмена не позднее, часов до начала" value={f.cancel} onChange={set('cancel')} />
        <TextInput label="Записываться вперёд, дней" value={f.horizon} onChange={set('horizon')} />
        <Button label="Сохранить" variant="primary" clickAction={save} width="100%" />
      </VStack>
      <HoursEditor ctx={ctx} onSaved={refresh} />
      <ServicesEditor ctx={ctx} onSaved={refresh} />
      <Banner status="info" title="Про повторную публикацию из файла настройки" description="Если студию заново публикуют из файла настройки, название, описание, услуги и график вернутся к значениям из файла. Записи и ваши фотографии не меняются." collapsible={false} />
    </VStack>
  );
}

function HoursEditor({ ctx, onSaved }: { ctx: OwnerContext; onSaved: () => unknown }) {
  const slug = ctx.tenant.slug;
  const [rows, setRows] = useState(() =>
    WEEKDAY_NAMES.map((_, i) => {
      const h = ctx.hours.find((x) => x.weekday === i + 1);
      return { open: !!h, opens: h?.opens ?? '09:00', closes: h?.closes ?? '20:00' };
    }),
  );
  const [msg, setMsg] = useState<{ s: 'success' | 'error'; t: string } | null>(null);
  const patch = (i: number, p: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const save = async () => {
    setMsg(null);
    try {
      if (rows.some((r) => r.open && r.closes <= r.opens)) throw new Error('Закрытие должно быть позже открытия.');
      const id = await tenantId(slug);
      const open = rows.flatMap((r, i) => (r.open ? [{ tenant_id: id, weekday: i + 1, opens: r.opens, closes: r.closes }] : []));
      const closed = rows.flatMap((r, i) => (r.open ? [] : [i + 1]));
      if (open.length) await table(slug, (c) => c.from('working_hours').upsert(open, { onConflict: 'tenant_id,weekday' }));
      for (const d of closed) await table(slug, (c) => c.from('working_hours').delete().eq('tenant_id', id).eq('weekday', d));
      await onSaved();
      setMsg({ s: 'success', t: 'График сохранён.' });
    } catch (e) {
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  };

  return (
    <VStack gap={3}>
      <Heading level={2}>График работы</Heading>
      {msg && <Banner status={msg.s} title={msg.t} collapsible={false} />}
      {WEEKDAY_NAMES.map((n, i) => (
        <HStack key={n} gap={2} vAlign="center" wrap="wrap">
          <label className="flex w-20 items-center gap-2"><input type="checkbox" checked={rows[i]!.open} onChange={(e) => patch(i, { open: e.target.checked })} className="size-5" />{n}</label>
          {rows[i]!.open ? (
            <>
              <LabeledInput label="С" type="time" value={rows[i]!.opens} onChange={(v) => patch(i, { opens: v })} />
              <LabeledInput label="До" type="time" value={rows[i]!.closes} onChange={(v) => patch(i, { closes: v })} />
            </>
          ) : (
            <Text color="secondary">выходной</Text>
          )}
        </HStack>
      ))}
      <Button label="Сохранить график" variant="primary" clickAction={save} width="100%" />
    </VStack>
  );
}

function ServicesEditor({ ctx, onSaved }: { ctx: OwnerContext; onSaved: () => unknown }) {
  const slug = ctx.tenant.slug;
  const [price, setPrice] = useState<Record<string, string>>(() => Object.fromEntries(ctx.services.map((s) => [s.id, String(Math.round(s.price_cents / 100))])));
  const [msg, setMsg] = useState<{ s: 'success' | 'error'; t: string } | null>(null);

  const saveOne = async (id: string, patch: Record<string, unknown>) => {
    setMsg(null);
    try {
      await table(slug, (c) => c.from('services').update(patch).eq('id', id));
      await onSaved();
      setMsg({ s: 'success', t: 'Сохранено. Уже созданные записи сохраняют прежнюю цену.' });
    } catch (e) {
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  };

  return (
    <VStack gap={3}>
      <Heading level={2}>Услуги</Heading>
      {msg && <Banner status={msg.s} title={msg.t} collapsible={false} />}
      {ctx.services.map((s) => (
        <VStack key={s.id} gap={2} className={`rounded-2xl border border-border bg-surface p-4 ${s.active ? '' : 'opacity-60'}`}>
          <Text weight="semibold">{s.name}</Text>
          <HStack gap={2} vAlign="end">
            <TextInput label="Цена, ₽" value={price[s.id] ?? ''} onChange={(v) => setPrice((p) => ({ ...p, [s.id]: v }))} />
            <Button label="Сохранить" variant="secondary" width={140} clickAction={() => saveOne(s.id, { price_cents: Math.max(0, num(price[s.id] ?? '0', 0)) * 100 })} />
          </HStack>
          <Button label={s.active ? 'Скрыть от клиентов' : 'Показать клиентам'} variant="ghost" clickAction={() => saveOne(s.id, { active: !s.active })} />
        </VStack>
      ))}
    </VStack>
  );
}
