-- Owner RPCs (authenticated + membership proven on the server) and service-only functions.

create function private.require_owner(p_slug text) returns public.tenants
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.tenants;
begin
  select * into t from public.tenants where slug = lower(coalesce(p_slug, ''));
  -- Same answer for "no such studio" and "not your studio": nothing to probe.
  if t.id is null or not private.is_member(t.id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return t;
end $$;

create function private.paid_cents(p_booking uuid) returns int
language sql stable as $$
  select coalesce(sum(case p.kind when 'payment' then p.amount_cents else -p.amount_cents end), 0)::int
  from public.payments p where p.booking_id = p_booking
$$;

-- ---------------------------------------------------------------- reads
create function public.owner_context(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.tenants;
begin
  t := private.require_owner(p_slug);
  return jsonb_build_object('ok', true,
    'tenant', to_jsonb(t) - 'id',
    'resources', coalesce((select jsonb_agg(to_jsonb(r) - 'tenant_id' - 'config_key' order by r.sort, r.name)
                           from public.resources r where r.tenant_id = t.id), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(to_jsonb(s) - 'tenant_id' - 'config_key' order by s.sort, s.name)
                          from public.services s where s.tenant_id = t.id), '[]'::jsonb),
    'service_resources', coalesce((select jsonb_agg(jsonb_build_object('service_id', sr.service_id, 'resource_id', sr.resource_id))
                          from public.service_resources sr where sr.tenant_id = t.id), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday,
                          'opens', to_char(w.opens, 'HH24:MI'), 'closes', to_char(w.closes, 'HH24:MI')) order by w.weekday)
                          from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),
    'days_off', coalesce((select jsonb_agg(jsonb_build_object('day', o.day, 'reason', o.reason) order by o.day)
                          from public.days_off o where o.tenant_id = t.id
                          and o.day >= (now() at time zone t.timezone)::date - 1), '[]'::jsonb),
    'cards', coalesce((select jsonb_agg(jsonb_build_object('position', c.position, 'title', c.title, 'body', c.body) order by c.position)
                          from public.info_cards c where c.tenant_id = t.id), '[]'::jsonb),
    'gallery', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'image_url', g.image_url,
                          'caption', g.caption, 'origin', g.origin) order by g.sort, g.created_at)
                          from public.gallery_items g where g.tenant_id = t.id), '[]'::jsonb));
end $$;

create function public.owner_bookings(p_slug text, p_from timestamptz, p_to timestamptz,
                                      p_include_cancelled boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.tenants;
begin
  t := private.require_owner(p_slug);
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '95 days' then
    return private.err('bad_range');
  end if;
  return jsonb_build_object('ok', true, 'timezone', t.timezone,
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'service_id', b.service_id, 'service_name', b.service_name,
        'resource_id', b.resource_id, 'resource', r.name,
        'starts_at', b.starts_at,
        'ends_at', b.starts_at + make_interval(mins => b.duration_minutes),
        'occupied_until', b.starts_at + make_interval(mins => b.duration_minutes + b.buffer_minutes),
        'customer_name', b.customer_name, 'customer_phone', b.customer_phone, 'car', b.car,
        'status', b.status, 'source', b.source, 'price_cents', b.price_cents,
        'paid_cents', private.paid_cents(b.id)) order by b.starts_at, b.created_at)
      from public.bookings b join public.resources r on r.id = b.resource_id
      where b.tenant_id = t.id
        and (p_include_cancelled or b.status <> 'cancelled')
        and b.starts_at < p_to
        and b.starts_at + make_interval(mins => b.duration_minutes + b.buffer_minutes) > p_from), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'resource_id', o.resource_id, 'resource', r.name,
        'from', lower(o.during), 'to', upper(o.during), 'reason', o.reason) order by lower(o.during))
      from public.resource_occupancies o join public.resources r on r.id = o.resource_id
      where o.tenant_id = t.id and o.kind = 'block' and o.during && tstzrange(p_from, p_to, '[)')), '[]'::jsonb));
end $$;

-- Statistics are computed here, once, for the UI and the AI alike.
--   arrivals   = cars actually accepted (accepted/done) whose slot starts in the period
--   completed  = work marked done, completed inside the period
--   received   = cash really taken: payments minus refunds dated inside the period
--   scheduled_value = price of still-unconfirmed bookings; a plan, never "revenue"
create function public.owner_stats(p_slug text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t public.tenants; v_from timestamptz; v_to timestamptz;
  v_arr int; v_done int; v_done_val bigint; v_pay bigint; v_ref bigint; v_sch int; v_sch_val bigint;
begin
  t := private.require_owner(p_slug);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    return private.err('bad_range');
  end if;
  v_from := p_from::timestamp at time zone t.timezone;
  v_to   := (p_to + 1)::timestamp at time zone t.timezone;
  select count(*) into v_arr from public.bookings b
    where b.tenant_id = t.id and b.status in ('accepted', 'done') and b.starts_at >= v_from and b.starts_at < v_to;
  select count(*), coalesce(sum(b.price_cents), 0) into v_done, v_done_val from public.bookings b
    where b.tenant_id = t.id and b.status = 'done' and b.completed_at >= v_from and b.completed_at < v_to;
  select coalesce(sum(p.amount_cents) filter (where p.kind = 'payment'), 0),
         coalesce(sum(p.amount_cents) filter (where p.kind = 'refund'), 0)
    into v_pay, v_ref from public.payments p
    where p.tenant_id = t.id and p.created_at >= v_from and p.created_at < v_to;
  select count(*), coalesce(sum(b.price_cents), 0) into v_sch, v_sch_val from public.bookings b
    where b.tenant_id = t.id and b.status = 'booked' and b.starts_at >= v_from and b.starts_at < v_to;
  return jsonb_build_object('ok', true, 'timezone', t.timezone,
    'from', p_from, 'to', p_to,
    'arrivals', v_arr,
    'completed', v_done, 'completed_value_cents', v_done_val,
    'received_cents', v_pay - v_ref, 'payments_cents', v_pay, 'refunds_cents', v_ref,
    'scheduled_count', v_sch, 'scheduled_value_cents', v_sch_val);
end $$;

-- ---------------------------------------------------------------- booking writes
create function public.owner_create_booking(
  p_slug text, p_service_id uuid, p_starts_at timestamptz, p_name text, p_phone text,
  p_car text, p_resource_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  t public.tenants; s public.services; ex public.bookings; b public.bookings;
  v_phone text; v_fp text; v_res text;
begin
  t := private.require_owner(p_slug);
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 100 then
    return private.err('bad_request');
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then return private.err('invalid_name'); end if;
  v_phone := private.normalize_phone(p_phone);
  if v_phone !~ '^\+?[0-9]{10,15}$' then return private.err('invalid_phone'); end if;
  perform pg_advisory_xact_lock(hashtextextended(t.id::text || ':' || p_idempotency_key, 0));
  v_fp := encode(extensions.digest(concat_ws('|', p_service_id, extract(epoch from p_starts_at)::bigint,
            v_phone, lower(btrim(p_name)), coalesce(p_resource_id::text, '')), 'sha256'), 'hex');
  select * into ex from public.bookings where tenant_id = t.id and idempotency_key = p_idempotency_key;
  if ex.id is not null then
    if ex.request_fingerprint <> v_fp then return private.err('idempotency_conflict'); end if;
    select r.name into v_res from public.resources r where r.id = ex.resource_id;
    return jsonb_build_object('ok', true, 'replayed', true, 'booking', private.booking_json(ex, v_res));
  end if;
  select * into s from public.services where id = p_service_id and tenant_id = t.id and active;
  if s.id is null then return private.err('service_not_found'); end if;
  if p_resource_id is not null and not exists (
       select 1 from public.resources r where r.id = p_resource_id and r.tenant_id = t.id and r.active) then
    return private.err('resource_not_found');
  end if;
  b := private.place_booking(t.id, s, p_starts_at, p_name, v_phone, p_car,
                             p_idempotency_key, v_fp, null, 'owner', p_resource_id);
  if b.id is null then return private.err('slot_taken'); end if;
  select r.name into v_res from public.resources r where r.id = b.resource_id;
  return jsonb_build_object('ok', true, 'replayed', false, 'booking', private.booking_json(b, v_res));
end $$;

-- Move = one atomic change of the occupancy row and the booking row. If every candidate box
-- is taken, nothing was written: the original booking stays exactly where it was.
create function public.owner_move_booking(p_slug text, p_booking_id uuid, p_new_starts_at timestamptz,
                                          p_resource_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.tenants; b public.bookings; v_range tstzrange; v_rid uuid; v_done boolean := false; v_res text;
begin
  t := private.require_owner(p_slug);
  select * into b from public.bookings where id = p_booking_id and tenant_id = t.id for update;
  if b.id is null then return private.err('not_found'); end if;
  if b.status not in ('booked', 'accepted') then return private.err('not_movable'); end if;
  if p_resource_id is not null and not exists (
       select 1 from public.resources r where r.id = p_resource_id and r.tenant_id = t.id and r.active) then
    return private.err('resource_not_found');
  end if;
  v_range := private.occupancy_range(p_new_starts_at, b.duration_minutes, b.buffer_minutes);

  -- Candidate order: requested box, else the current box first, then the others.
  for v_rid in
    select r.id from public.resources r
    where r.tenant_id = t.id and r.active and (p_resource_id is null or r.id = p_resource_id)
    order by (r.id = b.resource_id) desc, r.sort, r.name, r.id
  loop
    begin
      update public.resource_occupancies set resource_id = v_rid, during = v_range where booking_id = b.id;
      update public.bookings set resource_id = v_rid, starts_at = p_new_starts_at where id = b.id;
      v_done := true;
      exit;
    exception when exclusion_violation then
      null;  -- sub-block rolled back; original rows untouched; try the next box
    end;
  end loop;
  if not v_done then return private.err('slot_taken'); end if;

  update public.notification_jobs set
      run_at = p_new_starts_at - interval '24 hours',
      status = case when p_new_starts_at - interval '24 hours' <= now() then 'cancelled' else 'pending' end,
      lease_until = null, attempts = 0
    where booking_id = b.id and status in ('pending', 'leased', 'sent', 'cancelled');
  select * into b from public.bookings where id = b.id;
  select r.name into v_res from public.resources r where r.id = b.resource_id;
  return jsonb_build_object('ok', true, 'booking', private.booking_json(b, v_res));
end $$;

create function public.owner_cancel_booking(p_slug text, p_booking_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; b public.bookings; v_paid int;
begin
  t := private.require_owner(p_slug);
  select * into b from public.bookings where id = p_booking_id and tenant_id = t.id for update;
  if b.id is null then return private.err('not_found'); end if;
  v_paid := private.paid_cents(b.id);
  if b.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'replayed', true, 'refund_due_cents', greatest(v_paid, 0));
  end if;
  if b.status = 'done' then return private.err('not_cancellable'); end if;
  update public.bookings set status = 'cancelled', cancelled_at = now() where id = b.id;
  delete from public.resource_occupancies where booking_id = b.id;
  update public.notification_jobs set status = 'cancelled', lease_until = null
    where booking_id = b.id and status in ('pending', 'leased');
  return jsonb_build_object('ok', true, 'replayed', false, 'refund_due_cents', greatest(v_paid, 0));
end $$;

create function public.owner_set_status(p_slug text, p_booking_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; b public.bookings;
begin
  t := private.require_owner(p_slug);
  if p_status not in ('booked', 'accepted', 'done') then return private.err('bad_status'); end if;
  select * into b from public.bookings where id = p_booking_id and tenant_id = t.id for update;
  if b.id is null then return private.err('not_found'); end if;
  if b.status = p_status then return jsonb_build_object('ok', true, 'replayed', true, 'status', b.status); end if;
  if b.status in ('cancelled', 'done') then return private.err('bad_transition', jsonb_build_object('from', b.status)); end if;
  if p_status = 'booked' and b.status <> 'accepted' then return private.err('bad_transition', jsonb_build_object('from', b.status)); end if;
  update public.bookings set
      status = p_status,
      accepted_at = case when p_status = 'booked' then null else coalesce(accepted_at, now()) end,
      completed_at = case when p_status = 'done' then now() else null end
    where id = b.id;
  if p_status = 'done' then
    update public.notification_jobs set status = 'cancelled', lease_until = null
      where booking_id = b.id and status in ('pending', 'leased');
  end if;
  return jsonb_build_object('ok', true, 'replayed', false, 'status', p_status);
end $$;

-- Payments and refunds. The booking row lock serialises concurrent entries, so the refund
-- cap (never refund more than was received) cannot be bypassed by a race.
create function public.owner_add_payment(
  p_slug text, p_booking_id uuid, p_kind text, p_amount_cents int, p_method text,
  p_note text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; b public.bookings; v_paid int; ex public.payments;
begin
  t := private.require_owner(p_slug);
  if p_kind not in ('payment', 'refund') then return private.err('bad_kind'); end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > 100000000 then return private.err('bad_amount'); end if;
  if coalesce(p_method, 'cash') not in ('cash', 'card', 'transfer', 'other') then return private.err('bad_method'); end if;
  select * into b from public.bookings where id = p_booking_id and tenant_id = t.id for update;
  if b.id is null then return private.err('not_found'); end if;
  if p_idempotency_key is not null then
    select * into ex from public.payments where tenant_id = t.id and idempotency_key = p_idempotency_key;
    if ex.id is not null then
      return jsonb_build_object('ok', true, 'replayed', true, 'paid_cents', private.paid_cents(b.id),
                                'balance_cents', b.price_cents - private.paid_cents(b.id));
    end if;
  end if;
  v_paid := private.paid_cents(b.id);
  if p_kind = 'refund' and p_amount_cents > v_paid then
    return private.err('refund_exceeds_received', jsonb_build_object('paid_cents', v_paid));
  end if;
  if p_kind = 'payment' and b.status = 'cancelled' then return private.err('booking_cancelled'); end if;
  insert into public.payments (tenant_id, booking_id, kind, amount_cents, method, note, idempotency_key, created_by)
  values (t.id, b.id, p_kind, p_amount_cents, coalesce(p_method, 'cash'), coalesce(left(p_note, 200), ''),
          p_idempotency_key, auth.uid());
  v_paid := private.paid_cents(b.id);
  return jsonb_build_object('ok', true, 'replayed', false, 'paid_cents', v_paid,
                            'balance_cents', b.price_cents - v_paid);
end $$;

-- ---------------------------------------------------------------- blocks and closed days
create function public.owner_block_resource(p_slug text, p_resource_id uuid, p_from timestamptz,
                                            p_to timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; v_id uuid;
begin
  t := private.require_owner(p_slug);
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '60 days' then
    return private.err('bad_range');
  end if;
  if not exists (select 1 from public.resources r where r.id = p_resource_id and r.tenant_id = t.id) then
    return private.err('resource_not_found');
  end if;
  begin
    insert into public.resource_occupancies (tenant_id, resource_id, kind, reason, during)
    values (t.id, p_resource_id, 'block', left(coalesce(p_reason, ''), 120), tstzrange(p_from, p_to, '[)'))
    returning id into v_id;
  exception when exclusion_violation then
    return private.err('overlaps_existing');
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.owner_unblock(p_slug text, p_occupancy_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; n int;
begin
  t := private.require_owner(p_slug);
  delete from public.resource_occupancies where id = p_occupancy_id and tenant_id = t.id and kind = 'block';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'removed', n);
end $$;

create function public.owner_close_day(p_slug text, p_day date, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants; v_n int;
begin
  t := private.require_owner(p_slug);
  if p_day is null then return private.err('bad_request'); end if;
  insert into public.days_off (tenant_id, day, reason) values (t.id, p_day, left(coalesce(p_reason, ''), 120))
  on conflict (tenant_id, day) do update set reason = excluded.reason;
  select count(*) into v_n from public.bookings b
    where b.tenant_id = t.id and b.status in ('booked', 'accepted')
      and (b.starts_at at time zone t.timezone)::date = p_day;
  -- Closing a day stops NEW starts; bookings already on it stay and are reported back.
  return jsonb_build_object('ok', true, 'existing_bookings', v_n);
end $$;

create function public.owner_reopen_day(p_slug text, p_day date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.tenants;
begin
  t := private.require_owner(p_slug);
  delete from public.days_off where tenant_id = t.id and day = p_day;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- service-role only
create function public.rate_hit(p_bucket text, p_limit int, p_window_seconds int) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  select private.hit_rate_limit(p_bucket, p_limit, p_window_seconds)
$$;

-- Reserve one LLM call against today's per-studio budget. The WHERE clause makes the
-- increment conditional, so concurrent callers cannot overshoot the limit.
create function public.llm_reserve(p_tenant uuid, p_call_limit int, p_token_limit bigint) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_calls int;
begin
  insert into public.llm_usage as u (tenant_id, day, calls, tokens)
  values (p_tenant, (now() at time zone 'utc')::date, 1, 0)
  on conflict (tenant_id, day) do update set calls = u.calls + 1
    where u.calls < p_call_limit and u.tokens < p_token_limit
  returning u.calls into v_calls;
  return v_calls is not null;
end $$;

create function public.llm_add_tokens(p_tenant uuid, p_tokens bigint) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.llm_usage set tokens = tokens + greatest(p_tokens, 0)
  where tenant_id = p_tenant and day = (now() at time zone 'utc')::date
$$;

-- Outbox claim with lease: SKIP LOCKED lets several dispatchers run safely; an expired
-- lease makes a crashed dispatcher's job claimable again.
create function public.claim_notification_jobs(p_limit int default 20, p_lease_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_jobs jsonb;
begin
  with due as (
    select j.id from public.notification_jobs j
    join public.bookings b on b.id = j.booking_id and b.status in ('booked', 'accepted')
    join public.tenants t on t.id = j.tenant_id and t.status = 'live'
    where (j.status = 'pending' and j.run_at <= now())
       or (j.status = 'leased' and j.lease_until < now())
    order by j.run_at
    limit p_limit
    for update of j skip locked
  ), claimed as (
    update public.notification_jobs j
      set status = 'leased', lease_until = now() + make_interval(secs => p_lease_seconds), attempts = j.attempts + 1
    from due where j.id = due.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'job_id', c.id, 'kind', c.kind, 'attempts', c.attempts,
      'booking', jsonb_build_object('id', b.id, 'service_name', b.service_name, 'starts_at', b.starts_at),
      'studio', jsonb_build_object('slug', t.slug, 'name', t.name, 'address', t.address, 'timezone', t.timezone),
      'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                                 from public.push_subscriptions s where s.booking_id = c.booking_id), '[]'::jsonb))), '[]'::jsonb)
    into v_jobs
  from claimed c join public.bookings b on b.id = c.booking_id join public.tenants t on t.id = c.tenant_id;
  return v_jobs;
end $$;

create function public.complete_notification_job(p_job uuid, p_ok boolean, p_error text default null,
                                                 p_retry_in_seconds int default 600) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.notification_jobs set
    status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
    run_at = case when p_ok or attempts >= 5 then run_at else now() + make_interval(secs => p_retry_in_seconds) end,
    lease_until = null, last_error = left(p_error, 300)
  where id = p_job and status = 'leased'
$$;

create function public.purge_expired() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.rate_limits where window_start < now() - interval '2 days';
  delete from public.notification_jobs where status in ('sent', 'cancelled', 'failed') and created_at < now() - interval '30 days';
  delete from public.llm_usage where day < (now() at time zone 'utc')::date - 60;
$$;

-- ---------------------------------------------------------------- deterministic output
-- jsonb renders timestamptz in the session time zone. Pin every API function to UTC so the
-- same instant is always emitted as ...Z, whatever the server or pooler is configured with.
-- Local-time logic is unaffected: it always names the studio's zone explicitly.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('alter function %s set timezone to %L', r.sig, 'UTC');
  end loop;
end $$;
