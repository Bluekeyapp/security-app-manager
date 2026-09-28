-- Configurable sites, incidents, live supervision, and reports.
-- Run after schema.sql and security-migration.sql.

create unique index if not exists idx_sites_name_lower on public.sites (lower(name));

alter table public.agents add column if not exists site_id uuid references public.sites(id) on delete restrict;
update public.agents
set site_id = '00000000-0000-0000-0000-000000000001'
where site_id is null;
alter table public.agents alter column site_id set not null;
alter table public.tours add column if not exists required_checkpoint_ids text[];

update public.checkpoints set kind = 'start' where id = 'post-a';
update public.checkpoints set kind = 'checkpoint' where id <> 'post-a' and kind <> 'checkpoint';
create unique index if not exists idx_one_start_per_site
on public.checkpoints (site_id)
where kind = 'start' and active = true;

create table if not exists public.incidents (
  id text primary key,
  tour_id text not null references public.tours(id) on delete cascade,
  site_id uuid references public.sites(id) on delete set null,
  agent_id text references public.agents(id) on delete set null,
  category text not null,
  note text,
  photo_data text,
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy double precision,
  created_at timestamptz not null default now()
);

create index if not exists idx_incidents_created_at on public.incidents(created_at desc);
create index if not exists idx_incidents_tour_id on public.incidents(tour_id);
alter table public.incidents enable row level security;

drop policy if exists "manager read incidents" on public.incidents;
create policy "manager read incidents"
on public.incidents for select to authenticated
using (public.is_current_user_manager());

drop policy if exists "manager read sites" on public.sites;
drop policy if exists "public read sites" on public.sites;
create policy "manager read sites"
on public.sites for select to authenticated
using (public.is_current_user_manager());

drop policy if exists "manager read checkpoints" on public.checkpoints;
drop policy if exists "public read checkpoints" on public.checkpoints;
create policy "manager read checkpoints"
on public.checkpoints for select to authenticated
using (public.is_current_user_manager());

drop function if exists public.authenticate_agent(text, text);
create function public.authenticate_agent(p_badge text, p_pin text)
returns table (id text, name text, badge text, site_id uuid, site_name text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_agent public.agents%rowtype;
begin
  select a.* into v_agent
  from public.agents a
  where lower(a.badge) = lower(trim(p_badge))
  limit 1;

  if not found or not v_agent.active or v_agent.pin_hash is null then return; end if;
  if v_agent.locked_until is not null and v_agent.locked_until > now() then return; end if;

  if v_agent.pin_hash <> extensions.crypt(p_pin, v_agent.pin_hash) then
    update public.agents
    set failed_login_attempts = failed_login_attempts + 1,
        locked_until = case when failed_login_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where public.agents.id = v_agent.id;
    return;
  end if;

  update public.agents set failed_login_attempts = 0, locked_until = null where public.agents.id = v_agent.id;
  return query
  select v_agent.id, v_agent.name, v_agent.badge, v_agent.site_id, s.name
  from public.sites s where s.id = v_agent.site_id and s.active = true;
end;
$$;
revoke all on function public.authenticate_agent(text, text) from public;
grant execute on function public.authenticate_agent(text, text) to anon, authenticated;

create or replace function public.get_agent_route(p_badge text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id text;
  v_site_id uuid;
  v_result jsonb;
begin
  select authenticated.id, authenticated.site_id
  into v_agent_id, v_site_id
  from public.authenticate_agent(p_badge, p_pin) authenticated
  limit 1;
  if not found then raise exception 'Invalid agent credentials' using errcode = '28000'; end if;

  select jsonb_build_object(
    'siteId', s.id,
    'siteName', s.name,
    'siteAddress', coalesce(s.address, ''),
    'points', coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'label', c.label,
      'kind', c.kind,
      'qrPayload', c.qr_payload,
      'aliases', jsonb_build_array(c.qr_payload)
    ) order by c.sort_order) filter (where c.id is not null), '[]'::jsonb)
  ) into v_result
  from public.sites s
  left join public.checkpoints c on c.site_id = s.id and c.active
  where s.id = v_site_id and s.active
  group by s.id, s.name, s.address;
  return v_result;
end;
$$;
revoke all on function public.get_agent_route(text, text) from public;
grant execute on function public.get_agent_route(text, text) to anon, authenticated;

drop function if exists public.manager_create_agent(text, text, text);
create function public.manager_create_agent(p_name text, p_badge text, p_pin text, p_site_id uuid)
returns table (id text, name text, badge text, active boolean, created_at timestamptz, site_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text;
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 or length(trim(p_badge)) < 2 then raise exception 'Name and badge are required' using errcode = '22023'; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must contain exactly 6 digits' using errcode = '22023'; end if;
  if not exists (select 1 from public.sites where public.sites.id = p_site_id and public.sites.active) then
    raise exception 'Active site required' using errcode = '22023';
  end if;

  v_id := 'agent-' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  insert into public.agents (id, name, badge, active, pin_hash, site_id)
  values (v_id, left(trim(p_name), 80), left(trim(p_badge), 32), true,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), p_site_id);

  return query select a.id, a.name, a.badge, a.active, a.created_at, a.site_id
  from public.agents a where a.id = v_id;
end;
$$;
revoke all on function public.manager_create_agent(text, text, text, uuid) from public;
grant execute on function public.manager_create_agent(text, text, text, uuid) to authenticated;

create or replace function public.manager_create_site(p_name text, p_address text)
returns table (id uuid, name text, address text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site_id uuid := gen_random_uuid();
  v_checkpoint_id text := 'start-' || replace(v_site_id::text, '-', '');
  v_payload text := 'SAB:' || upper(replace(gen_random_uuid()::text, '-', ''));
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 then raise exception 'Site name required' using errcode = '22023'; end if;

  insert into public.sites (id, name, address, active)
  values (v_site_id, left(trim(p_name), 100), left(trim(coalesce(p_address, '')), 180), true);
  insert into public.checkpoints (id, site_id, label, kind, qr_payload, sort_order, active)
  values (v_checkpoint_id, v_site_id, 'Poste A', 'start', v_payload, 0, true);

  return query select s.id, s.name, s.address, s.active, s.created_at from public.sites s where s.id = v_site_id;
end;
$$;
revoke all on function public.manager_create_site(text, text) from public;
grant execute on function public.manager_create_site(text, text) to authenticated;

create or replace function public.manager_create_checkpoint(p_site_id uuid, p_label text)
returns table (id text, site_id uuid, label text, kind text, qr_payload text, sort_order integer, active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text := 'point-' || replace(gen_random_uuid()::text, '-', '');
  v_payload text := 'SAB:' || upper(replace(gen_random_uuid()::text, '-', ''));
  v_order integer;
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if length(trim(p_label)) < 2 then raise exception 'Checkpoint label required' using errcode = '22023'; end if;
  if not exists (select 1 from public.sites where public.sites.id = p_site_id and public.sites.active) then
    raise exception 'Active site required' using errcode = '22023';
  end if;
  select coalesce(max(c.sort_order), 0) + 1 into v_order from public.checkpoints c where c.site_id = p_site_id;
  insert into public.checkpoints (id, site_id, label, kind, qr_payload, sort_order, active)
  values (v_id, p_site_id, left(trim(p_label), 100), 'checkpoint', v_payload, v_order, true);
  return query select c.id, c.site_id, c.label, c.kind, c.qr_payload, c.sort_order, c.active
  from public.checkpoints c where c.id = v_id;
end;
$$;
revoke all on function public.manager_create_checkpoint(uuid, text) from public;
grant execute on function public.manager_create_checkpoint(uuid, text) to authenticated;

create or replace function public.manager_set_checkpoint_active(p_checkpoint_id text, p_active boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if exists (select 1 from public.checkpoints where id = p_checkpoint_id and kind = 'start') then
    raise exception 'Starting post cannot be disabled' using errcode = '22023';
  end if;
  update public.checkpoints set active = p_active where id = p_checkpoint_id;
  return found;
end;
$$;
revoke all on function public.manager_set_checkpoint_active(text, boolean) from public;
grant execute on function public.manager_set_checkpoint_active(text, boolean) to authenticated;

create or replace function public.sync_agent_tour(p_badge text, p_pin text, p_tour jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_agent public.agents%rowtype;
  v_agent_id text;
  v_tour_id text;
  v_status text;
  v_scan jsonb;
  v_incident jsonb;
  v_checkpoint public.checkpoints%rowtype;
  v_expected integer;
  v_required text[];
begin
  select authenticated.id into v_agent_id from public.authenticate_agent(p_badge, p_pin) authenticated limit 1;
  if not found then raise exception 'Invalid agent credentials' using errcode = '28000'; end if;
  select a.* into strict v_agent from public.agents a where a.id = v_agent_id;
  if jsonb_typeof(p_tour) <> 'object' or jsonb_typeof(p_tour->'scans') <> 'array' then
    raise exception 'Invalid tour payload' using errcode = '22023';
  end if;

  v_tour_id := left(nullif(trim(p_tour->>'id'), ''), 100);
  v_status := p_tour->>'status';
  if v_tour_id is null or v_status not in ('active', 'completed', 'cancelled') then
    raise exception 'Invalid tour data' using errcode = '22023';
  end if;
  if exists (select 1 from public.tours t where t.id = v_tour_id and t.agent_id is distinct from v_agent.id) then
    raise exception 'Tour belongs to another agent' using errcode = '42501';
  end if;

  select t.required_checkpoint_ids into v_required from public.tours t where t.id = v_tour_id;
  if v_required is null then
    select coalesce(array_agg(c.id order by c.sort_order), array[]::text[]) into v_required
    from public.checkpoints c where c.site_id = v_agent.site_id and c.kind = 'checkpoint' and c.active;
  end if;
  v_expected := cardinality(v_required);
  if (select count(*) from jsonb_array_elements(p_tour->'scans') s where s->>'type' = 'start') <> 1 then
    raise exception 'Tour must contain one start scan' using errcode = '22023';
  end if;
  if exists (select s->>'pointId' from jsonb_array_elements(p_tour->'scans') s
    where s->>'type' = 'checkpoint' group by s->>'pointId' having count(*) > 1) then
    raise exception 'Duplicate checkpoint scan' using errcode = '22023';
  end if;
  if v_status = 'completed' and (
    (select count(*) from jsonb_array_elements(p_tour->'scans') s where s->>'type' = 'checkpoint') <> v_expected
    or (select count(*) from jsonb_array_elements(p_tour->'scans') s where s->>'type' = 'close') <> 1
    or exists (select 1 from unnest(v_required) required_id where not exists (
      select 1 from jsonb_array_elements(p_tour->'scans') s
      where s->>'type' = 'checkpoint' and s->>'pointId' = required_id
    ))
  ) then raise exception 'Completed tour is missing required scans' using errcode = '22023'; end if;

  insert into public.tours (id, site_id, agent_id, agent_name, agent_badge, status, started_at,
    completed_at, cancelled_at, cancel_reason, comment, required_checkpoint_ids, updated_at)
  values (v_tour_id, v_agent.site_id, v_agent.id, v_agent.name, v_agent.badge, v_status,
    (p_tour->>'startedAt')::timestamptz, nullif(p_tour->>'completedAt', '')::timestamptz,
    nullif(p_tour->>'cancelledAt', '')::timestamptz, left(coalesce(p_tour->>'cancelReason', ''), 180),
    left(coalesce(p_tour->>'comment', ''), 500), v_required, now())
  on conflict (id) do update set status = excluded.status, completed_at = excluded.completed_at,
    cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
    comment = excluded.comment, updated_at = now();

  for v_scan in select value from jsonb_array_elements(p_tour->'scans') loop
    select c.* into v_checkpoint from public.checkpoints c
    where c.id = v_scan->>'pointId' and c.site_id = v_agent.site_id;
    if not found then raise exception 'Unknown checkpoint' using errcode = '22023'; end if;
    if (v_checkpoint.kind = 'start' and v_scan->>'type' not in ('start', 'close'))
      or (v_checkpoint.kind = 'checkpoint' and v_scan->>'type' <> 'checkpoint') then
      raise exception 'Scan type does not match checkpoint' using errcode = '22023';
    end if;
    insert into public.tour_scans (id, tour_id, agent_id, checkpoint_id, point_label, scan_type,
      scanned_at, source_payload, gps_lat, gps_lng, gps_accuracy)
    values (left(v_scan->>'id', 100), v_tour_id, v_agent.id, v_checkpoint.id, v_checkpoint.label,
      v_scan->>'type', (v_scan->>'scannedAt')::timestamptz,
      left(coalesce(v_scan->>'sourcePayload', ''), 160),
      nullif(v_scan#>>'{gps,lat}', '')::double precision,
      nullif(v_scan#>>'{gps,lng}', '')::double precision,
      nullif(v_scan#>>'{gps,accuracy}', '')::double precision)
    on conflict (id) do update set gps_lat = excluded.gps_lat, gps_lng = excluded.gps_lng,
      gps_accuracy = excluded.gps_accuracy;
  end loop;

  if jsonb_typeof(p_tour->'incidents') = 'array' then
    for v_incident in select value from jsonb_array_elements(p_tour->'incidents') loop
      if length(coalesce(v_incident->>'photoData', '')) > 600000 then
        raise exception 'Incident photo too large' using errcode = '22023';
      end if;
      if coalesce(v_incident->>'photoData', '') <> '' and v_incident->>'photoData' not like 'data:image/jpeg;base64,%' then
        raise exception 'Invalid incident photo' using errcode = '22023';
      end if;
      insert into public.incidents (id, tour_id, site_id, agent_id, category, note, photo_data,
        gps_lat, gps_lng, gps_accuracy, created_at)
      values (left(v_incident->>'id', 100), v_tour_id, v_agent.site_id, v_agent.id,
        left(coalesce(v_incident->>'category', 'Incident'), 40), left(coalesce(v_incident->>'note', ''), 500),
        nullif(v_incident->>'photoData', ''),
        nullif(v_incident#>>'{gps,lat}', '')::double precision,
        nullif(v_incident#>>'{gps,lng}', '')::double precision,
        nullif(v_incident#>>'{gps,accuracy}', '')::double precision,
        coalesce(nullif(v_incident->>'createdAt', '')::timestamptz, now()))
      on conflict (id) do update set category = excluded.category, note = excluded.note,
        photo_data = excluded.photo_data;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'tour_id', v_tour_id);
end;
$$;
revoke all on function public.sync_agent_tour(text, text, jsonb) from public;
grant execute on function public.sync_agent_tour(text, text, jsonb) to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tours') then
    alter publication supabase_realtime add table public.tours;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tour_scans') then
    alter publication supabase_realtime add table public.tour_scans;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'incidents') then
    alter publication supabase_realtime add table public.incidents;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agents') then
    alter publication supabase_realtime add table public.agents;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sites') then
    alter publication supabase_realtime add table public.sites;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'checkpoints') then
    alter publication supabase_realtime add table public.checkpoints;
  end if;
end $$;
