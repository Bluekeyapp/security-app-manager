-- Apply after clear-activity-history.sql. Requires pgcrypto in extensions.
begin;

create table if not exists public.remembered_agent_sessions (
  token_hash bytea primary key,
  agent_id text not null references public.agents(id) on delete cascade,
  pin_hash_at_issue text not null,
  session_epoch uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists remembered_agent_sessions_agent_id_idx
  on public.remembered_agent_sessions (agent_id);
alter table public.remembered_agent_sessions enable row level security;
revoke all on table public.remembered_agent_sessions from public, anon, authenticated;

create or replace function public.resolve_remembered_agent(p_token text)
returns public.agents language plpgsql security definer set search_path = public, extensions as $$
declare v_agent public.agents%rowtype;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  -- Share lock makes the global session reset and a request mutually exclusive.
  perform 1 from public.app_control where id = true for share;
  select a.* into v_agent
  from public.remembered_agent_sessions s
  join public.agents a on a.id = s.agent_id
  join public.app_control c on c.id = true
  where s.token_hash = extensions.digest(p_token, 'sha256')
    and s.expires_at > now()
    and s.session_epoch = c.agent_session_epoch
    and s.pin_hash_at_issue = a.pin_hash
    and a.active
    and (a.all_sites_access or exists (
      select 1 from public.sites site where site.id = a.site_id and site.active
    ))
  for share of s, a;
  if not found then return null; end if;
  return v_agent;
end;
$$;

create or replace function public.create_remembered_agent_session(p_badge text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_agent record; v_token text; v_epoch uuid; v_pin_hash text;
begin
  select * into v_agent from public.authenticate_agent(p_badge, p_pin) limit 1;
  if not found then return null; end if;
  select pin_hash into v_pin_hash from public.agents where id = v_agent.id;
  -- A concurrent PIN reset must not let an old PIN mint a token for the new hash.
  if v_pin_hash is null or v_pin_hash <> extensions.crypt(p_pin, v_pin_hash) then return null; end if;
  select agent_session_epoch into v_epoch from public.app_control where id = true for share;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.remembered_agent_sessions
    (token_hash, agent_id, pin_hash_at_issue, session_epoch, expires_at)
  values (extensions.digest(v_token, 'sha256'), v_agent.id, v_pin_hash, v_epoch,
    now() + interval '30 days');
  return jsonb_build_object('id', v_agent.id, 'name', v_agent.name,
    'badge', v_agent.badge, 'site_id', v_agent.site_id,
    'site_name', v_agent.site_name, 'session_epoch', v_epoch, 'token', v_token);
end;
$$;

create or replace function public.resume_remembered_agent_session(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_agent public.agents%rowtype;
begin
  v_agent := public.resolve_remembered_agent(p_token);
  if v_agent.id is null then return null; end if;
  return jsonb_build_object('id', v_agent.id, 'name', v_agent.name,
    'badge', v_agent.badge, 'site_id', v_agent.site_id,
    'site_name', (select name from public.sites where id = v_agent.site_id));
end;
$$;

create or replace function public.revoke_remembered_agent_session(p_token text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return; end if;
  delete from public.remembered_agent_sessions
  where token_hash = extensions.digest(p_token, 'sha256');
end;
$$;

create or replace function public.get_agent_routes_token(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_agent public.agents%rowtype; v_result jsonb;
begin
  v_agent := public.resolve_remembered_agent(p_token);
  if v_agent.id is null then
    raise exception 'Agent session expired' using errcode = '28000';
  end if;
  select coalesce(jsonb_agg(route order by route->>'siteName'), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'siteId', s.id, 'siteName', s.name, 'siteAddress', coalesce(s.address, ''),
      'points', coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'label', c.label, 'kind', c.kind,
        'qrPayload', c.qr_payload, 'aliases', jsonb_build_array(c.qr_payload)
      ) order by c.sort_order) filter (where c.id is not null), '[]'::jsonb)
    ) as route
    from public.sites s
    left join public.checkpoints c on c.site_id = s.id and c.active
    where s.active and (v_agent.all_sites_access or s.id = v_agent.site_id)
    group by s.id, s.name, s.address
  ) routes;
  return v_result;
end;
$$;

-- Keep the validation below aligned with sync_agent_tour in operations-upgrade.sql.

create or replace function public.sync_agent_tour_token(p_token text, p_tour jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_agent public.agents%rowtype;
  v_site_id uuid;
  v_tour_id text;
  v_status text;
  v_scan jsonb;
  v_incident jsonb;
  v_checkpoint public.checkpoints%rowtype;
  v_expected integer;
  v_required text[];
begin
  v_agent := public.resolve_remembered_agent(p_token);
  if v_agent.id is null then raise exception 'Agent session expired' using errcode = '28000'; end if;
  v_site_id := nullif(p_tour->>'siteId', '')::uuid;
  if v_site_id is null or not exists (
    select 1 from public.sites s where s.id = v_site_id and s.active
      and (v_agent.all_sites_access or s.id = v_agent.site_id)
  ) then raise exception 'Agent is not authorized for this site' using errcode = '42501'; end if;
  v_agent.site_id := v_site_id;
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

revoke all on function public.resolve_remembered_agent(text) from public, anon, authenticated;
revoke all on function public.create_remembered_agent_session(text, text) from public, anon, authenticated;
revoke all on function public.resume_remembered_agent_session(text) from public, anon, authenticated;
revoke all on function public.revoke_remembered_agent_session(text) from public, anon, authenticated;
revoke all on function public.get_agent_routes_token(text) from public, anon, authenticated;
revoke all on function public.sync_agent_tour_token(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_remembered_agent_session(text, text) to anon, authenticated;
grant execute on function public.resume_remembered_agent_session(text) to anon, authenticated;
grant execute on function public.revoke_remembered_agent_session(text) to anon, authenticated;
grant execute on function public.get_agent_routes_token(text) to anon, authenticated;
grant execute on function public.sync_agent_tour_token(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
