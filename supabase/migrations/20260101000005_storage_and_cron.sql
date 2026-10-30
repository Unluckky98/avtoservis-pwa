-- Supabase-only pieces. Each block is a no-op when the platform part is absent
-- (plain PostgreSQL in CI / local SQL tests).

-- Storage bucket for owner uploads. Path convention: <tenant_id>/<file>.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tenant-media', 'tenant-media', true, 8388608,
            array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    execute $p$ create policy tenant_media_read on storage.objects for select
                using (bucket_id = 'tenant-media') $p$;
    execute $p$ create policy tenant_media_insert on storage.objects for insert to authenticated
                with check (bucket_id = 'tenant-media'
                  and private.is_member(((storage.foldername(name))[1])::uuid)) $p$;
    execute $p$ create policy tenant_media_update on storage.objects for update to authenticated
                using (bucket_id = 'tenant-media'
                  and private.is_member(((storage.foldername(name))[1])::uuid)) $p$;
    execute $p$ create policy tenant_media_delete on storage.objects for delete to authenticated
                using (bucket_id = 'tenant-media'
                  and private.is_member(((storage.foldername(name))[1])::uuid)) $p$;
  end if;
end $$;

-- Daily housekeeping through Supabase Cron when pg_cron is available.
-- The per-minute push dispatch needs project secrets and is scheduled by hand: see SETUP.md.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('avto-purge-expired', '17 3 * * *', 'select public.purge_expired()');
  end if;
end $$;
