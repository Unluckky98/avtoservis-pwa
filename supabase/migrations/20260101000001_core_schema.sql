-- Core schema. Every tenant-dependent table carries tenant_id and uses composite FKs
-- (tenant_id, x_id) so a row can never point at another tenant's parent.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;

create function private.tz_ok(p_tz text) returns boolean
language sql stable as $$
  select exists (select 1 from pg_catalog.pg_timezone_names n where n.name = p_tz)
$$;

-- ---------------------------------------------------------------- tenants
create table public.tenants (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique
                        check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                text not null check (char_length(name) between 2 and 80),
  tagline             text not null default '' check (char_length(tagline) <= 200),
  description         text not null default '' check (char_length(description) <= 1200),
  timezone            text not null check (private.tz_ok(timezone)),
  status              text not null default 'preview' check (status in ('preview', 'live')),
  is_demo             boolean not null default false,
  accent              text not null default '#4690FF' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  address             text not null default '',
  phone               text not null default '',
  logo_url            text,
  hero_url            text,
  hero_alt            text not null default '',
  slot_step_minutes   int  not null default 30 check (slot_step_minutes between 5 and 240),
  lead_time_minutes   int  not null default 60 check (lead_time_minutes between 0 and 20160),
  cancel_before_hours int  not null default 24 check (cancel_before_hours between 0 and 720),
  max_horizon_days    int  not null default 60 check (max_horizon_days between 1 and 365),
  config_version      int  not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null,
  role       text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- ---------------------------------------------------------------- catalog
create table public.resources (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  active     boolean not null default true,
  sort       int not null default 0,
  config_key text,
  unique (tenant_id, id),
  unique (tenant_id, config_key)
);

create table public.services (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null check (char_length(name) between 2 and 80),
  description      text not null default '' check (char_length(description) <= 600),
  price_cents      int  not null check (price_cents >= 0),
  duration_minutes int  not null check (duration_minutes between 5 and 20160),
  buffer_minutes   int  not null default 0 check (buffer_minutes between 0 and 1440),
  active           boolean not null default true,
  sort             int not null default 0,
  config_key       text,
  unique (tenant_id, id),
  unique (tenant_id, config_key)
);

-- Optional restriction: which resources fit a service. No rows = every active resource fits.
create table public.service_resources (
  tenant_id   uuid not null,
  service_id  uuid not null,
  resource_id uuid not null,
  primary key (service_id, resource_id),
  foreign key (tenant_id, service_id)  references public.services(tenant_id, id)  on delete cascade,
  foreign key (tenant_id, resource_id) references public.resources(tenant_id, id) on delete cascade
);

-- One working interval per ISO weekday (1 = Monday ... 7 = Sunday). No row = closed.
create table public.working_hours (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  weekday   smallint not null check (weekday between 1 and 7),
  opens     time not null,
  closes    time not null,
  primary key (tenant_id, weekday),
  check (closes > opens)
);

create table public.days_off (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day       date not null,
  reason    text not null default '',
  primary key (tenant_id, day)
);

create table public.info_cards (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  position  smallint not null check (position between 1 and 3),
  title     text not null check (char_length(title) between 1 and 60),
  body      text not null default '' check (char_length(body) <= 300),
  primary key (tenant_id, position)
);

create table public.gallery_items (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  image_url  text not null,
  caption    text not null default '' check (char_length(caption) <= 120),
  sort       int not null default 0,
  origin     text not null default 'owner' check (origin in ('config', 'owner')),
  config_key text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, config_key)
);

-- ---------------------------------------------------------------- bookings
create table public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  service_id          uuid not null,
  resource_id         uuid not null,
  -- Snapshot of what was sold: price and durations never follow later catalog edits.
  service_name        text not null,
  price_cents         int  not null check (price_cents >= 0),
  duration_minutes    int  not null check (duration_minutes > 0),
  buffer_minutes      int  not null check (buffer_minutes >= 0),
  starts_at           timestamptz not null,
  customer_name       text not null check (char_length(customer_name) between 2 and 80),
  customer_phone      text not null check (customer_phone ~ '^\+?[0-9]{10,15}$'),
  car                 text not null default '' check (char_length(car) <= 80),
  status              text not null default 'booked'
                        check (status in ('booked', 'accepted', 'done', 'cancelled')),
  source              text not null default 'client' check (source in ('client', 'owner')),
  idempotency_key     text,
  request_fingerprint text,
  access_token_hash   bytea,
  accepted_at         timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, service_id)  references public.services(tenant_id, id),
  foreign key (tenant_id, resource_id) references public.resources(tenant_id, id)
);
create unique index bookings_idem_uq on public.bookings (tenant_id, idempotency_key)
  where idempotency_key is not null;
create unique index bookings_token_uq on public.bookings (access_token_hash)
  where access_token_hash is not null;
create index bookings_tenant_start_idx on public.bookings (tenant_id, starts_at);

-- One table for "a booking holds a box" and "the owner blocked a box".
-- The EXCLUDE constraint is the single arbiter of double-booking.
create table public.resource_occupancies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  resource_id uuid not null,
  booking_id  uuid,
  kind        text not null check (kind in ('booking', 'block')),
  reason      text not null default '',
  during      tstzrange not null check (not isempty(during) and lower_inc(during) and not upper_inc(during)),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, resource_id) references public.resources(tenant_id, id),
  foreign key (tenant_id, booking_id)  references public.bookings(tenant_id, id) on delete cascade,
  check ((kind = 'booking') = (booking_id is not null)),
  constraint resource_occupancies_no_overlap
    exclude using gist (resource_id with =, during with &&)
);
create unique index resource_occupancies_booking_uq on public.resource_occupancies (booking_id)
  where booking_id is not null;
create index resource_occupancies_tenant_idx on public.resource_occupancies (tenant_id, resource_id);

-- ---------------------------------------------------------------- payments
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  booking_id      uuid not null,
  kind            text not null check (kind in ('payment', 'refund')),
  amount_cents    int  not null check (amount_cents > 0),
  method          text not null default 'cash' check (method in ('cash', 'card', 'transfer', 'other')),
  note            text not null default '' check (char_length(note) <= 200),
  idempotency_key text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references public.bookings(tenant_id, id)
);
create unique index payments_idem_uq on public.payments (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index payments_tenant_created_idx on public.payments (tenant_id, created_at);

-- ---------------------------------------------------------------- notifications
create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references public.bookings(tenant_id, id) on delete cascade
);

-- Outbox with lease + dedupe: one reminder per booking.
create table public.notification_jobs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  booking_id uuid not null,
  kind       text not null default 'reminder_24h' check (kind in ('reminder_24h')),
  run_at     timestamptz not null,
  status     text not null default 'pending'
               check (status in ('pending', 'leased', 'sent', 'cancelled', 'failed')),
  lease_until timestamptz,
  attempts   int not null default 0,
  last_error text,
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, booking_id) references public.bookings(tenant_id, id) on delete cascade
);
create index notification_jobs_due_idx on public.notification_jobs (run_at)
  where status in ('pending', 'leased');

-- ---------------------------------------------------------------- limits & budget
create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);

create table public.llm_usage (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  day         date not null,
  calls       int  not null default 0,
  tokens      bigint not null default 0,
  primary key (tenant_id, day)
);

-- Server-only secrets (token HMAC key). Lives in the private schema, never exposed by the API.
create table private.secrets (
  key   text primary key,
  value text not null
);
insert into private.secrets (key, value)
values ('booking_token_hmac', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict do nothing;
