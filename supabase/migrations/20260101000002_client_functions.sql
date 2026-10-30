-- Helpers and the public (client-facing) RPC surface.
-- Business failures return {ok:false, code:...} instead of raising, so rate-limit
-- counters written earlier in the same call are committed, not rolled back.

-- ---------------------------------------------------------------- helpers
create function private.err(p_code text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'code', p_code) || p_extra $$;

create function private.is_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant and m.user_id = auth.uid()
  )
$$;

create function private.normalize_phone(p_raw text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g');
begin
  if length(d) = 11 and left(d, 1) in ('7', '8') then return '+7' || substr(d, 2); end if;
  if length(d) = 10 then return '+7' || d; end if;
  return '+' || d;
end $$;

create function private.token_for(p_tenant uuid, p_key text) returns text
language sql stable security definer set search_path = public, extensions, private, pg_temp as $$
  select encode(
    extensions.hmac(p_tenant::text || ':' || p_key,
                    (select s.value from private.secrets s where s.key = 'booking_token_hmac'),
                    'sha256'), 'hex')
$$;

create function private.token_hash(p_token text) returns bytea
language sql immutable as $$ select extensions.digest(p_token, 'sha256') $$;

create function private.client_ip() returns text
language plpgsql stable as $$
declare h jsonb;
begin
  h := nullif(current_setting('request.headers', true), '')::jsonb;
  return coalesce(h ->> 'cf-connecting-ip', nullif(trim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''), 'unknown');
exception when others then return 'unknown';
end $$;

-- Atomic fixed-window counter. One statement: no read-then-write race.
create function private.hit_rate_limit(p_bucket text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_start timestamptz; v_hits int;
begin
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (bucket, window_start, hits) values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  return v_hits <= p_limit;
end $$;

create function private.occupancy_range(p_start timestamptz, p_duration int, p_buffer int) returns tstzrange
language sql immutable as $$
  select tstzrange(p_start, p_start + make_interval(mins => p_duration + p_buffer), '[)')
$$;

-- Resources that fit the service and are free for the whole range, in stable order.
create function private.free_resource_ids(p_tenant uuid, p_service uuid, p_range tstzrange)
returns setof uuid language sql stable as $$
  select r.id
  from public.resources r
  where r.tenant_id = p_tenant and r.active
    and (not exists (select 1 from public.service_resources sr where sr.service_id = p_service)
         or exists (select 1 from public.service_resources sr
                    where sr.service_id = p_service and sr.resource_id = r.id))
    and not exists (select 1 from public.resource_occupancies o
                    where o.resource_id = r.id and o.during && p_range)
  order by r.sort, r.name, r.id
$$;

-- Candidate start moments from the working schedule (no occupancy check here).
-- Working hours define when a car can be accepted. A service that fits inside one
-- working window must also finish before closing; a longer (multi-day) service is only
-- constrained by its start moment and then holds the box continuously.
create function private.slot_candidates(p_tenant uuid, p_service uuid, p_from date, p_to date)
returns table (slot_start timestamptz, slot_range tstzrange)
language plpgsql stable as $$
declare
  t public.tenants; s public.services; wh public.working_hours;
  d date; loc timestamp; v_win int; v_step interval;
begin
  select * into t from public.tenants where id = p_tenant;
  select * into s from public.services where id = p_service and tenant_id = p_tenant and active;
  if t.id is null or s.id is null then return; end if;
  v_step := make_interval(mins => t.slot_step_minutes);
  for d in select g::date from generate_series(p_from, p_to, interval '1 day') g loop
    select * into wh from public.working_hours w
      where w.tenant_id = p_tenant and w.weekday = extract(isodow from d)::int;
    continue when wh.tenant_id is null;
    continue when exists (select 1 from public.days_off o where o.tenant_id = p_tenant and o.day = d);
    v_win := (extract(epoch from (wh.closes - wh.opens)) / 60)::int;
    for loc in select g from generate_series(d + wh.opens, d + wh.closes - v_step, v_step) g loop
      if s.duration_minutes <= v_win
         and loc + make_interval(mins => s.duration_minutes) > d + wh.closes then
        continue;
      end if;
      slot_start := loc at time zone t.timezone;
      slot_range := private.occupancy_range(slot_start, s.duration_minutes, s.buffer_minutes);
      return next;
    end loop;
  end loop;
end $$;

-- Insert booking + occupancy atomically, trying suitable boxes in order.
-- The EXCLUDE constraint decides; losing a race just moves on to the next box.
create function private.place_booking(
  p_tenant uuid, p_service public.services, p_starts timestamptz,
  p_name text, p_phone text, p_car text, p_key text, p_fp text,
  p_token_hash bytea, p_source text, p_resource uuid default null)
returns public.bookings language plpgsql as $$
declare
  v_range tstzrange := private.occupancy_range(p_starts, p_service.duration_minutes, p_service.buffer_minutes);
  v_rid uuid; b public.bookings;
begin
  for v_rid in
    select id from private.free_resource_ids(p_tenant, p_service.id, v_range) id
    where p_resource is null or id = p_resource
  loop
    begin
      insert into public.bookings (tenant_id, service_id, resource_id, service_name, price_cents,
        duration_minutes, buffer_minutes, starts_at, customer_name, customer_phone, car,
        source, idempotency_key, request_fingerprint, access_token_hash)
      values (p_tenant, p_service.id, v_rid, p_service.name, p_service.price_cents,
        p_service.duration_minutes, p_service.buffer_minutes, p_starts, btrim(p_name), p_phone,
        btrim(coalesce(p_car, '')), p_source, p_key, p_fp, p_token_hash)
      returning * into b;
      insert into public.resource_occupancies (tenant_id, resource_id, booking_id, kind, during)
      values (p_tenant, v_rid, b.id, 'booking', v_range);
      return b;
    exception when exclusion_violation then
      b := null;  -- someone took this box a moment ago; the sub-block rolled back; try the next
    end;
  end loop;
  return null;
end $$;

create function private.booking_json(b public.bookings, p_resource_name text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', b.id, 'status', b.status, 'service_name', b.service_name,
    'price_cents', b.price_cents, 'starts_at', b.starts_at,
    'ends_at', b.starts_at + make_interval(mins => b.duration_minutes),
    'duration_minutes', b.duration_minutes, 'resource', p_resource_name,
    'customer_name', b.customer_name, 'car', b.car)
$$;

-- ---------------------------------------------------------------- public reads
create function public.studio_public(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.tenants;
begin
  select * into t from public.tenants where slug = lower(p_slug);
  if t.id is null then return private.err('not_found'); end if;
  return jsonb_build_object('ok', true, 'studio', jsonb_build_object(
    'slug', t.slug, 'name', t.name, 'tagline', t.tagline, 'description', t.description,
    'timezone', t.timezone, 'preview', t.status <> 'live', 'is_demo', t.is_demo,
    'accent', t.accent, 'address', t.address, 'phone', t.phone,
    'logo_url', t.logo_url, 'hero_url', t.hero_url, 'hero_alt', t.hero_alt,
    'slot_step_minutes', t.slot_step_minutes, 'cancel_before_hours', t.cancel_before_hours,
    'services', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'description', s.description,
        'price_cents', s.price_cents, 'duration_minutes', s.duration_minutes)
        order by s.sort, s.name)
      from public.services s where s.tenant_id = t.id and s.active), '[]'::jsonb),
    'gallery', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'image_url', g.image_url, 'caption', g.caption) order by g.sort, g.created_at)
      from public.gallery_items g where g.tenant_id = t.id), '[]'::jsonb),
    'cards', coalesce((select jsonb_agg(jsonb_build_object(
        'position', c.position, 'title', c.title, 'body', c.body) order by c.position)
      from public.info_cards c where c.tenant_id = t.id), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object(
        'weekday', w.weekday, 'opens', to_char(w.opens, 'HH24:MI'), 'closes', to_char(w.closes, 'HH24:MI'))
        order by w.weekday)
      from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),
    'days_off', coalesce((select jsonb_agg(o.day order by o.day)
      from public.days_off o where o.tenant_id = t.id
        and o.day >= (now() at time zone t.timezone)::date), '[]'::jsonb)
  ));
end $$;

create function public.availability(p_slug text, p_service_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.tenants; v_slots jsonb;
begin
  select * into t from public.tenants where slug = lower(p_slug);
  if t.id is null then return private.err('not_found'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 31 then
    return private.err('bad_range');
  end if;
  if not exists (select 1 from public.services s where s.id = p_service_id and s.tenant_id = t.id and s.active) then
    return private.err('service_not_found');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'start', c.slot_start,
           'available', exists (select 1 from private.free_resource_ids(t.id, p_service_id, c.slot_range)))
         order by c.slot_start), '[]'::jsonb)
    into v_slots
  from private.slot_candidates(t.id, p_service_id, p_from, p_to) c
  where c.slot_start >= now() + make_interval(mins => t.lead_time_minutes)
    and c.slot_start <= now() + make_interval(days => t.max_horizon_days);
  return jsonb_build_object('ok', true, 'timezone', t.timezone, 'slots', v_slots);
end $$;

-- ---------------------------------------------------------------- client booking
create function public.create_booking(
  p_slug text, p_service_id uuid, p_starts_at timestamptz,
  p_name text, p_phone text, p_car text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  t public.tenants; s public.services; ex public.bookings; b public.bookings;
  v_phone text; v_fp text; v_token text; v_res text; v_local date;
begin
  select * into t from public.tenants where slug = lower(p_slug);
  if t.id is null then return private.err('not_found'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 100 then
    return private.err('bad_request');
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then return private.err('invalid_name'); end if;
  v_phone := private.normalize_phone(p_phone);
  if v_phone !~ '^\+?[0-9]{10,15}$' then return private.err('invalid_phone'); end if;
  if char_length(coalesce(p_car, '')) > 80 then return private.err('invalid_car'); end if;

  -- Same key + same request = same booking and the same access token (safe retry).
  perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':' || p_idempotency_key, 0));
  v_fp := encode(extensions.digest(concat_ws('|', p_service_id, extract(epoch from p_starts_at)::bigint,
            v_phone, lower(btrim(p_name))), 'sha256'), 'hex');
  select * into ex from public.bookings where tenant_id = t.id and idempotency_key = p_idempotency_key;
  if ex.id is not null then
    if ex.request_fingerprint <> v_fp then return private.err('idempotency_conflict'); end if;
    select r.name into v_res from public.resources r where r.id = ex.resource_id;
    return jsonb_build_object('ok', true, 'replayed', true,
      'access_token', private.token_for(t.id, p_idempotency_key),
      'booking', private.booking_json(ex, v_res));
  end if;

  if not private.hit_rate_limit('book:phone:' || t.id || ':' || v_phone, 5, 3600)
     or not private.hit_rate_limit('book:ip:' || private.client_ip(), 40, 3600)
     or not private.hit_rate_limit('book:tenant:' || t.id, 400, 3600) then
    return private.err('rate_limited');
  end if;

  select * into s from public.services where id = p_service_id and tenant_id = t.id and active;
  if s.id is null then return private.err('service_not_found'); end if;
  if p_starts_at < now() + make_interval(mins => t.lead_time_minutes)
     or p_starts_at > now() + make_interval(days => t.max_horizon_days) then
    return private.err('slot_unavailable');
  end if;
  v_local := (p_starts_at at time zone t.timezone)::date;
  if not exists (select 1 from private.slot_candidates(t.id, s.id, v_local, v_local) c
                 where c.slot_start = p_starts_at) then
    return private.err('slot_unavailable');
  end if;

  v_token := private.token_for(t.id, p_idempotency_key);
  b := private.place_booking(t.id, s, p_starts_at, p_name, v_phone, p_car,
                             p_idempotency_key, v_fp, private.token_hash(v_token), 'client');
  if b.id is null then return private.err('slot_taken'); end if;
  select r.name into v_res from public.resources r where r.id = b.resource_id;
  return jsonb_build_object('ok', true, 'replayed', false, 'access_token', v_token,
                            'booking', private.booking_json(b, v_res));
end $$;

create function public.my_booking(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b public.bookings; t public.tenants; v_res text; v_deadline timestamptz;
begin
  if p_token is null or char_length(p_token) <> 64 then return private.err('not_found'); end if;
  select * into b from public.bookings where access_token_hash = private.token_hash(p_token);
  if b.id is null then return private.err('not_found'); end if;
  select * into t from public.tenants where id = b.tenant_id;
  select r.name into v_res from public.resources r where r.id = b.resource_id;
  v_deadline := b.starts_at - make_interval(hours => t.cancel_before_hours);
  return jsonb_build_object('ok', true,
    'booking', private.booking_json(b, v_res),
    'studio', jsonb_build_object('slug', t.slug, 'name', t.name, 'address', t.address,
                                 'phone', t.phone, 'timezone', t.timezone, 'preview', t.status <> 'live'),
    'cancel_deadline', v_deadline,
    'can_cancel', b.status in ('booked', 'accepted') and now() <= v_deadline,
    'cancel_before_hours', t.cancel_before_hours,
    'reminder', exists (select 1 from public.notification_jobs j
                        where j.booking_id = b.id and j.status in ('pending', 'leased', 'sent')));
end $$;

create function public.cancel_my_booking(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; t public.tenants;
begin
  if p_token is null or char_length(p_token) <> 64 then return private.err('not_found'); end if;
  select * into b from public.bookings where access_token_hash = private.token_hash(p_token) for update;
  if b.id is null then return private.err('not_found'); end if;
  if b.status = 'cancelled' then return jsonb_build_object('ok', true, 'replayed', true); end if;
  select * into t from public.tenants where id = b.tenant_id;
  if b.status not in ('booked', 'accepted') then return private.err('not_cancellable'); end if;
  if now() > b.starts_at - make_interval(hours => t.cancel_before_hours) then
    return private.err('too_late', jsonb_build_object('cancel_before_hours', t.cancel_before_hours));
  end if;
  update public.bookings set status = 'cancelled', cancelled_at = now() where id = b.id;
  delete from public.resource_occupancies where booking_id = b.id;
  update public.notification_jobs set status = 'cancelled', lease_until = null
    where booking_id = b.id and status in ('pending', 'leased');
  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

-- Reminder opt-in. Preview studios never create real notification jobs.
create function public.enable_reminder(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; t public.tenants; v_run timestamptz;
begin
  if p_token is null or char_length(p_token) <> 64 then return private.err('not_found'); end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    return private.err('bad_request');
  end if;
  select * into b from public.bookings where access_token_hash = private.token_hash(p_token);
  if b.id is null then return private.err('not_found'); end if;
  if b.status not in ('booked', 'accepted') then return private.err('not_active'); end if;
  select * into t from public.tenants where id = b.tenant_id;
  if t.status <> 'live' then
    return jsonb_build_object('ok', true, 'enabled', false, 'reason', 'preview');
  end if;
  if not private.hit_rate_limit('push:' || b.id, 10, 3600) then return private.err('rate_limited'); end if;
  v_run := b.starts_at - interval '24 hours';
  if v_run <= now() then
    return jsonb_build_object('ok', true, 'enabled', false, 'reason', 'too_soon');
  end if;
  insert into public.push_subscriptions (tenant_id, booking_id, endpoint, p256dh, auth)
  values (b.tenant_id, b.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth
    where public.push_subscriptions.booking_id = excluded.booking_id;
  insert into public.notification_jobs as j (tenant_id, booking_id, run_at, dedupe_key)
  values (b.tenant_id, b.id, v_run, b.id::text || ':reminder_24h')
  on conflict (dedupe_key) do update
    set run_at = excluded.run_at, status = 'pending', lease_until = null, attempts = 0
    where j.status in ('pending', 'cancelled', 'failed');
  return jsonb_build_object('ok', true, 'enabled', true, 'run_at', v_run);
end $$;
