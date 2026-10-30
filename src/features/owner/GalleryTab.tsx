import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Banner } from '@astryxdesign/core/Banner';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { ownerClient } from '../../lib/supabase';
import { EmptyState } from '../../components/States';
import { table, tenantId, type OwnerContext } from './ownerApi';

const BUCKET = 'tenant-media';
const MAX_BYTES = 8 * 1024 * 1024;

/** Resizes in the browser so phone photos (often 10+ MB) stay light. */
async function toJpeg(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
}

export function GalleryTab({ ctx }: { ctx: OwnerContext }) {
  const slug = ctx.tenant.slug;
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ s: 'success' | 'error'; t: string } | null>(null);
  const [captions, setCaptions] = useState<Record<string, string>>(() => Object.fromEntries(ctx.gallery.map((g) => [g.id, g.caption ?? ''])));
  const [del, setDel] = useState<(typeof ctx.gallery)[number] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['owner', slug, 'context'] }).then(() => qc.invalidateQueries({ queryKey: ['studio', slug] }));

  async function upload(file: File) {
    setMsg(null);
    try {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Подойдут фото JPG, PNG или WebP.');
      if (file.size > 40 * 1024 * 1024) throw new Error('Файл слишком большой.');
      const blob = await toJpeg(file);
      if (blob.size > MAX_BYTES) throw new Error('Фото слишком тяжёлое даже после сжатия.');
      const id = await tenantId(slug);
      const path = `${id}/${crypto.randomUUID()}.jpg`;
      const c = ownerClient(slug);
      const up = await c.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw new Error('Не удалось загрузить фото. Проверьте связь и повторите.');
      const { data } = c.storage.from(BUCKET).getPublicUrl(path);
      const next = Math.max(0, ...ctx.gallery.map((_, i) => i + 1));
      try {
        await table(slug, (cl) => cl.from('gallery_items').insert({ tenant_id: id, image_url: data.publicUrl, caption: '', sort: next, origin: 'owner' }));
      } catch (e) {
        await c.storage.from(BUCKET).remove([path]); // no orphan file if the row failed
        throw e;
      }
      await refresh();
      setMsg({ s: 'success', t: 'Фото добавлено.' });
    } catch (e) {
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  }

  async function saveCaption(id: string) {
    setMsg(null);
    try {
      await table(slug, (c) => c.from('gallery_items').update({ caption: (captions[id] ?? '').slice(0, 120) }).eq('id', id));
      await refresh();
      setMsg({ s: 'success', t: 'Подпись сохранена.' });
    } catch (e) {
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  }

  async function remove(g: (typeof ctx.gallery)[number]) {
    setMsg(null);
    try {
      await table(slug, (c) => c.from('gallery_items').delete().eq('id', g.id));
      const marker = `/${BUCKET}/`;
      const i = g.image_url.indexOf(marker);
      if (g.origin === 'owner' && i >= 0) await ownerClient(slug).storage.from(BUCKET).remove([g.image_url.slice(i + marker.length)]);
      setDel(null);
      await refresh();
      setMsg({ s: 'success', t: 'Фото удалено.' });
    } catch (e) {
      setDel(null);
      setMsg({ s: 'error', t: e instanceof Error ? e.message : 'Ошибка' });
    }
  }

  return (
    <VStack gap={4}>
      <Heading level={2}>Фотографии работ</Heading>
      {msg && <Banner status={msg.s} title={msg.t} isDismissable onDismiss={() => setMsg(null)} collapsible={false} />}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} aria-label="Выбрать фото" />
      <Button label="Добавить фото" variant="primary" onClick={() => input.current?.click()} />
      {ctx.gallery.length === 0 && <EmptyState title="Фотографий пока нет" text="Добавьте первое фото работ — оно появится на главной." />}
      <VStack gap={3} as="ul" className="m-0 p-0 list-none">
        {ctx.gallery.map((g) => (
          <li key={g.id} className="rounded-2xl border border-border bg-surface p-3">
            <VStack gap={2}>
              <img src={g.image_url} alt={g.caption ?? 'Фото'} className="aspect-[4/3] w-full rounded-xl object-cover" loading="lazy" />
              <TextInput label="Подпись" value={captions[g.id] ?? ''} onChange={(v) => setCaptions((c) => ({ ...c, [g.id]: v }))} />
              <HStack gap={2}>
                <Button label="Сохранить подпись" variant="secondary" clickAction={() => saveCaption(g.id)} width="100%" />
                <Button label="Удалить" variant="destructive" onClick={() => setDel(g)} />
              </HStack>
              {g.origin === 'config' && <Text type="supporting">Фото из настроек студии: при повторной публикации оно вернётся, если осталось в файле.</Text>}
            </VStack>
          </li>
        ))}
      </VStack>
      <AlertDialog isOpen={!!del} onOpenChange={(o) => !o && setDel(null)} title="Удалить фото?" description="Фото исчезнет с главной страницы." actionLabel="Удалить" cancelLabel="Оставить" onAction={() => del && void remove(del)} />
    </VStack>
  );
}
