-- Row level security, strict GRANTs, function EXECUTE lists.
-- Model: anon never touches a table. Public data and booking flows go through the
-- security-definer RPCs above. Owners (authenticated) read/write only catalog tables of
-- the tenants they are members of. Bookings, payments, tokens, subscriptions, outbox,
-- limits and secrets have RLS enabled and NO policies: no direct access for API roles.

-- ---------------------------------------------------------------- stop default exposure
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
-- Objects created by other platform roles. On hosted Supabase the migration role is not a
-- member of supabase_admin, so this is skipped; our own objects are covered by the statements
-- above and by the explicit REVOKE ... ON ALL ... below.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated';
  end if;
exception when insufficient_privilege then
  raise notice 'skipped default privileges for supabase_admin (not permitted for this role)';
end $$;

revoke all on all tables    in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- enable RLS everywhere
alter table public.tenants              enable row level security;
alter table public.tenant_members       enable row level security;
alter table public.resources            enable row level security;
alter table public.services             enable row level security;
alter table public.service_resources    enable row level security;
alter table public.working_hours        enable row level security;
alter table public.days_off             enable row level security;
alter table public.info_cards           enable row level security;
alter table public.gallery_items        enable row level security;
alter table public.bookings             enable row level security;
alter table public.resource_occupancies enable row level security;
alter table public.payments             enable row level security;
alter table public.push_subscriptions   enable row level security;
alter table public.notification_jobs    enable row level security;
alter table public.rate_limits          enable row level security;
alter table public.llm_usage            enable row level security;
alter table private.secrets             enable row level security;
alter table public.tenants              force row level security;

-- ---------------------------------------------------------------- owner policies
create policy tenants_member_select on public.tenants for select to authenticated
  using (private.is_member(id));
create policy tenants_member_update on public.tenants for update to authenticated
  using (private.is_member(id)) with check (private.is_member(id));

create policy members_self_select on public.tenant_members for select to authenticated
  using (user_id = auth.uid());

create policy resources_member_all on public.resources for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy services_member_all on public.services for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy service_resources_member_all on public.service_resources for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy working_hours_member_all on public.working_hours for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy days_off_member_all on public.days_off for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy info_cards_member_all on public.info_cards for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));
create policy gallery_member_all on public.gallery_items for all to authenticated
  using (private.is_member(tenant_id)) with check (private.is_member(tenant_id));

-- ---------------------------------------------------------------- table grants
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema private to authenticated;          -- RLS policies call private.is_member
grant execute on function private.is_member(uuid) to authenticated;
-- CHECK constraints run with the caller's rights: owners updating tenants evaluate tz_ok.
grant execute on function private.tz_ok(text) to authenticated;

grant select on public.tenants        to authenticated;
-- Owners edit presentation only. status / slug / is_demo / config_version are not theirs.
grant update (name, tagline, description, address, phone, logo_url, hero_url, hero_alt,
              accent, slot_step_minutes, lead_time_minutes, cancel_before_hours, max_horizon_days,
              updated_at)
  on public.tenants to authenticated;
grant select on public.tenant_members to authenticated;
grant select, insert, update, delete on
  public.resources, public.services, public.service_resources, public.working_hours,
  public.days_off, public.info_cards, public.gallery_items
  to authenticated;

grant all on all tables    in schema public  to service_role;
grant all on all tables    in schema private to service_role;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------- function grants
grant execute on function
  public.studio_public(text),
  public.availability(text, uuid, date, date),
  public.create_booking(text, uuid, timestamptz, text, text, text, text),
  public.my_booking(text),
  public.cancel_my_booking(text),
  public.enable_reminder(text, text, text, text)
  to anon, authenticated;

grant execute on function
  public.owner_context(text),
  public.owner_bookings(text, timestamptz, timestamptz, boolean),
  public.owner_stats(text, date, date),
  public.owner_create_booking(text, uuid, timestamptz, text, text, text, uuid, text),
  public.owner_move_booking(text, uuid, timestamptz, uuid),
  public.owner_cancel_booking(text, uuid),
  public.owner_set_status(text, uuid, text),
  public.owner_add_payment(text, uuid, text, int, text, text, text),
  public.owner_block_resource(text, uuid, timestamptz, timestamptz, text),
  public.owner_unblock(text, uuid),
  public.owner_close_day(text, date, text),
  public.owner_reopen_day(text, date)
  to authenticated;

-- Server-only: edge functions use the service role. Never granted to anon/authenticated.
grant execute on function
  public.rate_hit(text, int, int),
  public.llm_reserve(uuid, int, bigint),
  public.llm_add_tokens(uuid, bigint),
  public.claim_notification_jobs(int, int),
  public.complete_notification_job(uuid, boolean, text, int),
  public.purge_expired()
  to service_role;
grant execute on all functions in schema private to service_role;
