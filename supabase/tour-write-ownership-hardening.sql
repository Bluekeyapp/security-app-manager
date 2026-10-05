-- Apply after agent-pin-null-hardening.sql, with all previous migrations installed.
-- Non-destructive: existing rows are preserved; only synchronizer functions change.
-- Ownership is checked on the locked conflict row, not only before the upsert.
-- A refused conflict raises an error and rolls back the whole synchronization.
begin;

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

  insert into public.tours as existing (id, site_id, agent_id, agent_name, agent_badge, status, started_at,
    completed_at, cancelled_at, cancel_reason, comment, required_checkpoint_ids, updated_at)
  values (v_tour_id, v_agent.site_id, v_agent.id, v_agent.name, v_agent.badge, v_status,
    (p_tour->>'startedAt')::timestamptz, nullif(p_tour->>'completedAt', '')::timestamptz,
    nullif(p_tour->>'cancelledAt', '')::timestamptz, left(coalesce(p_tour->>'cancelReason', ''), 180),
    left(coalesce(p_tour->>'comment', ''), 500), v_required, now())
  on conflict (id) do update set status = excluded.status, completed_at = excluded.completed_at,
    cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
    comment = excluded.comment, updated_at = now()
  where existing.agent_id = excluded.agent_id and existing.site_id = excluded.site_id;
  if not found then
    raise exception 'Tour belongs to another agent or site' using errcode = '42501';
  end if;

  for v_scan in select value from jsonb_array_elements(p_tour->'scans') loop
    select c.* into v_checkpoint from public.checkpoints c
    where c.id = v_scan->>'pointId' and c.site_id = v_agent.site_id;
    if not found then raise exception 'Unknown checkpoint' using errcode = '22023'; end if;
    if (v_checkpoint.kind = 'start' and v_scan->>'type' not in ('start', 'close'))
      or (v_checkpoint.kind = 'checkpoint' and v_scan->>'type' <> 'checkpoint') then
      raise exception 'Scan type does not match checkpoint' using errcode = '22023';
    end if;
    insert into public.tour_scans as existing (id, tour_id, agent_id, checkpoint_id, point_label, scan_type,
      scanned_at, source_payload, gps_lat, gps_lng, gps_accuracy)
    values (left(v_scan->>'id', 100), v_tour_id, v_agent.id, v_checkpoint.id, v_checkpoint.label,
      v_scan->>'type', (v_scan->>'scannedAt')::timestamptz,
      left(coalesce(v_scan->>'sourcePayload', ''), 160),
      nullif(v_scan#>>'{gps,lat}', '')::double precision,
      nullif(v_scan#>>'{gps,lng}', '')::double precision,
      nullif(v_scan#>>'{gps,accuracy}', '')::double precision)
    on conflict (id) do update set gps_lat = excluded.gps_lat, gps_lng = excluded.gps_lng,
      gps_accuracy = excluded.gps_accuracy
    where existing.tour_id = excluded.tour_id and existing.agent_id = excluded.agent_id;
    if not found then
      raise exception 'Scan belongs to another tour or agent' using errcode = '42501';
    end if;
  end loop;

  if jsonb_typeof(p_tour->'incidents') = 'array' then
    for v_incident in select value from jsonb_array_elements(p_tour->'incidents') loop
      if length(coalesce(v_incident->>'photoData', '')) > 600000 then
        raise exception 'Incident photo too large' using errcode = '22023';
      end if;
      if coalesce(v_incident->>'photoData', '') <> '' and v_incident->>'photoData' not like 'data:image/jpeg;base64,%' then
        raise exception 'Invalid incident photo' using errcode = '22023';
      end if;
      insert into public.incidents as existing (id, tour_id, site_id, agent_id, category, note, photo_data,
        gps_lat, gps_lng, gps_accuracy, created_at)
      values (left(v_incident->>'id', 100), v_tour_id, v_agent.site_id, v_agent.id,
        left(coalesce(v_incident->>'category', 'Incident'), 40), left(coalesce(v_incident->>'note', ''), 500),
        nullif(v_incident->>'photoData', ''),
        nullif(v_incident#>>'{gps,lat}', '')::double precision,
        nullif(v_incident#>>'{gps,lng}', '')::double precision,
        nullif(v_incident#>>'{gps,accuracy}', '')::double precision,
        coalesce(nullif(v_incident->>'createdAt', '')::timestamptz, now()))
      on conflict (id) do update set category = excluded.category, note = excluded.note,
        photo_data = excluded.photo_data
      where existing.tour_id = excluded.tour_id and existing.agent_id = excluded.agent_id
        and existing.site_id = excluded.site_id;
      if not found then
        raise exception 'Incident belongs to another tour, agent or site' using errcode = '42501';
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'tour_id', v_tour_id);
end;
$$;

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

  insert into public.tours as existing (id, site_id, agent_id, agent_name, agent_badge, status, started_at,
    completed_at, cancelled_at, cancel_reason, comment, required_checkpoint_ids, updated_at)
  values (v_tour_id, v_agent.site_id, v_agent.id, v_agent.name, v_agent.badge, v_status,
    (p_tour->>'startedAt')::timestamptz, nullif(p_tour->>'completedAt', '')::timestamptz,
    nullif(p_tour->>'cancelledAt', '')::timestamptz, left(coalesce(p_tour->>'cancelReason', ''), 180),
    left(coalesce(p_tour->>'comment', ''), 500), v_required, now())
  on conflict (id) do update set status = excluded.status, completed_at = excluded.completed_at,
    cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
    comment = excluded.comment, updated_at = now()
  where existing.agent_id = excluded.agent_id and existing.site_id = excluded.site_id;
  if not found then
    raise exception 'Tour belongs to another agent or site' using errcode = '42501';
  end if;

  for v_scan in select value from jsonb_array_elements(p_tour->'scans') loop
    select c.* into v_checkpoint from public.checkpoints c
    where c.id = v_scan->>'pointId' and c.site_id = v_agent.site_id;
    if not found then raise exception 'Unknown checkpoint' using errcode = '22023'; end if;
    if (v_checkpoint.kind = 'start' and v_scan->>'type' not in ('start', 'close'))
      or (v_checkpoint.kind = 'checkpoint' and v_scan->>'type' <> 'checkpoint') then
      raise exception 'Scan type does not match checkpoint' using errcode = '22023';
    end if;
    insert into public.tour_scans as existing (id, tour_id, agent_id, checkpoint_id, point_label, scan_type,
      scanned_at, source_payload, gps_lat, gps_lng, gps_accuracy)
    values (left(v_scan->>'id', 100), v_tour_id, v_agent.id, v_checkpoint.id, v_checkpoint.label,
      v_scan->>'type', (v_scan->>'scannedAt')::timestamptz,
      left(coalesce(v_scan->>'sourcePayload', ''), 160),
      nullif(v_scan#>>'{gps,lat}', '')::double precision,
      nullif(v_scan#>>'{gps,lng}', '')::double precision,
      nullif(v_scan#>>'{gps,accuracy}', '')::double precision)
    on conflict (id) do update set gps_lat = excluded.gps_lat, gps_lng = excluded.gps_lng,
      gps_accuracy = excluded.gps_accuracy
    where existing.tour_id = excluded.tour_id and existing.agent_id = excluded.agent_id;
    if not found then
      raise exception 'Scan belongs to another tour or agent' using errcode = '42501';
    end if;
  end loop;

  if jsonb_typeof(p_tour->'incidents') = 'array' then
    for v_incident in select value from jsonb_array_elements(p_tour->'incidents') loop
      if length(coalesce(v_incident->>'photoData', '')) > 600000 then
        raise exception 'Incident photo too large' using errcode = '22023';
      end if;
      if coalesce(v_incident->>'photoData', '') <> '' and v_incident->>'photoData' not like 'data:image/jpeg;base64,%' then
        raise exception 'Invalid incident photo' using errcode = '22023';
      end if;
      insert into public.incidents as existing (id, tour_id, site_id, agent_id, category, note, photo_data,
        gps_lat, gps_lng, gps_accuracy, created_at)
      values (left(v_incident->>'id', 100), v_tour_id, v_agent.site_id, v_agent.id,
        left(coalesce(v_incident->>'category', 'Incident'), 40), left(coalesce(v_incident->>'note', ''), 500),
        nullif(v_incident->>'photoData', ''),
        nullif(v_incident#>>'{gps,lat}', '')::double precision,
        nullif(v_incident#>>'{gps,lng}', '')::double precision,
        nullif(v_incident#>>'{gps,accuracy}', '')::double precision,
        coalesce(nullif(v_incident->>'createdAt', '')::timestamptz, now()))
      on conflict (id) do update set category = excluded.category, note = excluded.note,
        photo_data = excluded.photo_data
      where existing.tour_id = excluded.tour_id and existing.agent_id = excluded.agent_id
        and existing.site_id = excluded.site_id;
      if not found then
        raise exception 'Incident belongs to another tour, agent or site' using errcode = '42501';
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'tour_id', v_tour_id);
end;
$$;

-- Keep the Badge/PIN synchronizer internal; its session wrapper is unchanged.
revoke all on function public.sync_agent_tour(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_agent_tour_token(text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_agent_tour_token(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
