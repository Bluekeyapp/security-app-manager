create extension if not exists pgcrypto with schema extensions;

alter table public.agents add column if not exists pin_hash text;
alter table public.agents add column if not exists failed_login_attempts integer not null default 0;
alter table public.agents add column if not exists locked_until timestamptz;
create unique index if not exists idx_agents_badge_lower on public.agents (lower(badge));

create table if not exists public.manager_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.manager_users enable row level security;

create or replace function public.is_current_user_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.manager_users
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_current_user_manager() from public;
grant execute on function public.is_current_user_manager() to authenticated;

drop policy if exists "manager read own membership" on public.manager_users;
create policy "manager read own membership"
on public.manager_users
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "public read agents" on public.agents;
drop policy if exists "public upsert agents" on public.agents;
drop policy if exists "public update agents" on public.agents;
drop policy if exists "manager read agents" on public.agents;
create policy "manager read agents"
on public.agents
for select
to authenticated
using (public.is_current_user_manager());

drop policy if exists "public read tours" on public.tours;
drop policy if exists "public insert tours" on public.tours;
drop policy if exists "public update tours" on public.tours;
drop policy if exists "manager read tours" on public.tours;
create policy "manager read tours"
on public.tours
for select
to authenticated
using (public.is_current_user_manager());

drop policy if exists "public read tour_scans" on public.tour_scans;
drop policy if exists "public insert tour_scans" on public.tour_scans;
drop policy if exists "public update tour_scans" on public.tour_scans;
drop policy if exists "manager read tour_scans" on public.tour_scans;
create policy "manager read tour_scans"
on public.tour_scans
for select
to authenticated
using (public.is_current_user_manager());

create or replace function public.authenticate_agent(p_badge text, p_pin text)
returns table (id text, name text, badge text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_agent public.agents%rowtype;
begin
  select a.*
  into v_agent
  from public.agents a
  where lower(a.badge) = lower(trim(p_badge))
  limit 1;

  if not found or not v_agent.active or v_agent.pin_hash is null then
    return;
  end if;

  if v_agent.locked_until is not null and v_agent.locked_until > now() then
    return;
  end if;

  if v_agent.pin_hash <> extensions.crypt(p_pin, v_agent.pin_hash) then
    update public.agents
    set
      failed_login_attempts = failed_login_attempts + 1,
      locked_until = case
        when failed_login_attempts + 1 >= 5 then now() + interval '15 minutes'
        else null
      end
    where public.agents.id = v_agent.id;
    return;
  end if;

  update public.agents
  set failed_login_attempts = 0, locked_until = null
  where public.agents.id = v_agent.id;

  return query select v_agent.id, v_agent.name, v_agent.badge;
end;
$$;

revoke all on function public.authenticate_agent(text, text) from public;
grant execute on function public.authenticate_agent(text, text) to anon, authenticated;

create or replace function public.manager_create_agent(p_name text, p_badge text, p_pin text)
returns table (id text, name text, badge text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text;
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;

  if length(trim(p_name)) < 2 or length(trim(p_badge)) < 2 then
    raise exception 'Name and badge are required' using errcode = '22023';
  end if;

  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must contain exactly 6 digits' using errcode = '22023';
  end if;

  v_id := 'agent-' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);

  insert into public.agents (id, name, badge, active, pin_hash)
  values (
    v_id,
    left(trim(p_name), 80),
    left(trim(p_badge), 32),
    true,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 10))
  );

  return query
  select a.id, a.name, a.badge, a.active, a.created_at
  from public.agents a
  where a.id = v_id;
end;
$$;

revoke all on function public.manager_create_agent(text, text, text) from public;
grant execute on function public.manager_create_agent(text, text, text) to authenticated;

create or replace function public.manager_set_agent_active(p_agent_id text, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;

  update public.agents
  set active = p_active
  where id = p_agent_id;

  return found;
end;
$$;

revoke all on function public.manager_set_agent_active(text, boolean) from public;
grant execute on function public.manager_set_agent_active(text, boolean) to authenticated;

create or replace function public.manager_reset_agent_pin(p_agent_id text, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;

  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must contain exactly 6 digits' using errcode = '22023';
  end if;

  update public.agents
  set
    pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
    failed_login_attempts = 0,
    locked_until = null
  where id = p_agent_id;

  return found;
end;
$$;

revoke all on function public.manager_reset_agent_pin(text, text) from public;
grant execute on function public.manager_reset_agent_pin(text, text) to authenticated;

create or replace function public.sync_agent_tour(p_badge text, p_pin text, p_tour jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_agent public.agents%rowtype;
  v_agent_id text;
  v_tour_id text;
  v_status text;
  v_scan jsonb;
  v_scan_id text;
  v_checkpoint_id text;
  v_point_label text;
  v_scan_type text;
begin
  select authenticated.id
  into v_agent_id
  from public.authenticate_agent(p_badge, p_pin) authenticated
  limit 1;

  if not found then
    raise exception 'Invalid agent credentials' using errcode = '28000';
  end if;

  select a.* into strict v_agent
  from public.agents a
  where a.id = v_agent_id;

  if jsonb_typeof(p_tour) <> 'object' then
    raise exception 'Invalid tour payload' using errcode = '22023';
  end if;

  if jsonb_typeof(p_tour->'scans') <> 'array' then
    raise exception 'Invalid scans payload' using errcode = '22023';
  end if;

  v_tour_id := left(nullif(trim(p_tour->>'id'), ''), 100);
  v_status := p_tour->>'status';

  if v_tour_id is null or v_status not in ('active', 'completed', 'cancelled') then
    raise exception 'Invalid tour data' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_array_elements(p_tour->'scans') scan where scan->>'pointId' = 'post-a' and scan->>'type' = 'start') <> 1 then
    raise exception 'Tour must contain one start scan' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_tour->'scans') scan
    where (scan->>'pointId' = 'post-a' and scan->>'type' not in ('start', 'close'))
       or (scan->>'pointId' <> 'post-a' and scan->>'type' <> 'checkpoint')
  ) then
    raise exception 'Scan type does not match checkpoint' using errcode = '22023';
  end if;

  if exists (
    select scan->>'pointId'
    from jsonb_array_elements(p_tour->'scans') scan
    where scan->>'type' = 'checkpoint'
    group by scan->>'pointId'
    having count(*) > 1
  ) then
    raise exception 'Duplicate checkpoint scan' using errcode = '22023';
  end if;

  if v_status = 'completed' and (
    jsonb_array_length(p_tour->'scans') <> 5
    or (select count(*) from jsonb_array_elements(p_tour->'scans') scan where scan->>'type' = 'checkpoint') <> 3
    or (select count(*) from jsonb_array_elements(p_tour->'scans') scan where scan->>'pointId' = 'post-a' and scan->>'type' = 'close') <> 1
  ) then
    raise exception 'Completed tour is missing required scans' using errcode = '22023';
  end if;

  if v_status <> 'completed' and exists (
    select 1 from jsonb_array_elements(p_tour->'scans') scan where scan->>'type' = 'close'
  ) then
    raise exception 'Only completed tours may contain a closing scan' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.tours t
    where t.id = v_tour_id and t.agent_id is distinct from v_agent.id
  ) then
    raise exception 'Tour belongs to another agent' using errcode = '42501';
  end if;

  insert into public.tours (
    id,
    site_id,
    agent_id,
    agent_name,
    agent_badge,
    status,
    started_at,
    completed_at,
    cancelled_at,
    cancel_reason,
    comment,
    updated_at
  ) values (
    v_tour_id,
    '00000000-0000-0000-0000-000000000001',
    v_agent.id,
    v_agent.name,
    v_agent.badge,
    v_status,
    (p_tour->>'startedAt')::timestamptz,
    nullif(p_tour->>'completedAt', '')::timestamptz,
    nullif(p_tour->>'cancelledAt', '')::timestamptz,
    left(coalesce(p_tour->>'cancelReason', ''), 180),
    left(coalesce(p_tour->>'comment', ''), 500),
    now()
  )
  on conflict (id) do update set
    status = excluded.status,
    completed_at = excluded.completed_at,
    cancelled_at = excluded.cancelled_at,
    cancel_reason = excluded.cancel_reason,
    comment = excluded.comment,
    updated_at = now();

  for v_scan in
    select value from jsonb_array_elements(coalesce(p_tour->'scans', '[]'::jsonb))
  loop
    v_scan_id := left(nullif(trim(v_scan->>'id'), ''), 100);
    v_checkpoint_id := v_scan->>'pointId';
    v_scan_type := v_scan->>'type';

    if v_scan_id is null or v_scan_type not in ('start', 'checkpoint', 'close') then
      raise exception 'Invalid scan data' using errcode = '22023';
    end if;

    select c.label into v_point_label
    from public.checkpoints c
    where c.id = v_checkpoint_id and c.active = true;

    if not found then
      raise exception 'Unknown checkpoint' using errcode = '22023';
    end if;

    if exists (
      select 1 from public.tour_scans s
      where s.id = v_scan_id and s.tour_id <> v_tour_id
    ) then
      raise exception 'Scan belongs to another tour' using errcode = '42501';
    end if;

    insert into public.tour_scans (
      id,
      tour_id,
      agent_id,
      checkpoint_id,
      point_label,
      scan_type,
      scanned_at,
      source_payload,
      gps_lat,
      gps_lng,
      gps_accuracy
    ) values (
      v_scan_id,
      v_tour_id,
      v_agent.id,
      v_checkpoint_id,
      v_point_label,
      v_scan_type,
      (v_scan->>'scannedAt')::timestamptz,
      left(coalesce(v_scan->>'sourcePayload', ''), 160),
      nullif(v_scan#>>'{gps,lat}', '')::double precision,
      nullif(v_scan#>>'{gps,lng}', '')::double precision,
      nullif(v_scan#>>'{gps,accuracy}', '')::double precision
    )
    on conflict (id) do update set
      gps_lat = excluded.gps_lat,
      gps_lng = excluded.gps_lng,
      gps_accuracy = excluded.gps_accuracy;
  end loop;

  return jsonb_build_object('ok', true, 'tour_id', v_tour_id);
end;
$$;

revoke all on function public.sync_agent_tour(text, text, jsonb) from public;
grant execute on function public.sync_agent_tour(text, text, jsonb) to anon, authenticated;

-- After creating the manager in Authentication > Users, authorize it once:
-- insert into public.manager_users (user_id)
-- select id from auth.users where email = 'manager@example.com'
-- on conflict (user_id) do nothing;
