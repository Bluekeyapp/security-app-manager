create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.agents (
  id text primary key,
  name text not null,
  badge text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.checkpoints (
  id text primary key,
  site_id uuid references public.sites(id) on delete cascade,
  label text not null,
  kind text not null,
  qr_payload text not null unique,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.tours (
  id text primary key,
  site_id uuid references public.sites(id) on delete set null,
  agent_id text references public.agents(id) on delete set null,
  agent_name text not null,
  agent_badge text not null,
  status text not null check (status in ('active', 'completed', 'cancelled')),
  started_at timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tours add column if not exists comment text;

create table if not exists public.tour_scans (
  id text primary key,
  tour_id text not null references public.tours(id) on delete cascade,
  agent_id text references public.agents(id) on delete set null,
  checkpoint_id text references public.checkpoints(id) on delete set null,
  point_label text not null,
  scan_type text not null check (scan_type in ('start', 'checkpoint', 'close')),
  scanned_at timestamptz not null,
  source_payload text,
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy double precision,
  created_at timestamptz not null default now()
);

alter table public.tour_scans add column if not exists gps_lat double precision;
alter table public.tour_scans add column if not exists gps_lng double precision;
alter table public.tour_scans add column if not exists gps_accuracy double precision;

create index if not exists idx_tours_started_at on public.tours(started_at desc);
create index if not exists idx_tours_status on public.tours(status);
create index if not exists idx_tour_scans_tour_id on public.tour_scans(tour_id);

insert into public.sites (id, name, address)
values ('00000000-0000-0000-0000-000000000001', 'Site de test', 'Poste A')
on conflict (id) do nothing;

insert into public.checkpoints (id, site_id, label, kind, qr_payload, sort_order)
values
  ('post-a', '00000000-0000-0000-0000-000000000001', 'Poste A', 'Poste de depart', 'POST_A', 0),
  ('checkpoint-1', '00000000-0000-0000-0000-000000000001', 'Point 1', 'Point de controle', 'CP_1', 1),
  ('checkpoint-2', '00000000-0000-0000-0000-000000000001', 'Point 2', 'Point de controle', 'CP_2', 2),
  ('checkpoint-3', '00000000-0000-0000-0000-000000000001', 'Point 3', 'Point de controle', 'CP_3', 3)
on conflict (id) do update set
  label = excluded.label,
  kind = excluded.kind,
  qr_payload = excluded.qr_payload,
  sort_order = excluded.sort_order,
  active = true;

alter table public.sites enable row level security;
alter table public.agents enable row level security;
alter table public.checkpoints enable row level security;
alter table public.tours enable row level security;
alter table public.tour_scans enable row level security;

-- New databases start closed. Later migrations add manager-only policies and
-- RPC access; there is no window with public access to agents or patrol data.
drop policy if exists "public read sites" on public.sites;
drop policy if exists "public read agents" on public.agents;
drop policy if exists "public upsert agents" on public.agents;
drop policy if exists "public update agents" on public.agents;
drop policy if exists "public read checkpoints" on public.checkpoints;
drop policy if exists "public read tours" on public.tours;
drop policy if exists "public insert tours" on public.tours;
drop policy if exists "public update tours" on public.tours;
drop policy if exists "public read tour_scans" on public.tour_scans;
drop policy if exists "public insert tour_scans" on public.tour_scans;
drop policy if exists "public update tour_scans" on public.tour_scans;
