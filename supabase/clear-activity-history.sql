-- Global agent-session reset and manager-only activity cleanup.
-- Run after all-agents-all-sites.sql.
begin;

create table if not exists public.app_control (
  id boolean primary key default true check (id),
  agent_session_epoch uuid not null default gen_random_uuid(),
  activity_reset_at timestamptz not null default '-infinity'::timestamptz
);

insert into public.app_control (id) values (true) on conflict (id) do nothing;
alter table public.app_control enable row level security;

create or replace function public.authenticate_agent_session(p_badge text, p_pin text)
returns table (
  id text, name text, badge text, site_id uuid, site_name text,
  all_sites_access boolean, session_epoch uuid
)
language plpgsql security definer set search_path = public as $$
declare
  v_agent record;
  v_epoch uuid;
begin
  select * into v_agent from public.authenticate_agent(p_badge, p_pin) limit 1;
  if not found then return; end if;
  select agent_session_epoch into v_epoch from public.app_control where app_control.id = true;
  return query select v_agent.id, v_agent.name, v_agent.badge, v_agent.site_id,
    v_agent.site_name, v_agent.all_sites_access, v_epoch;
end;
$$;

create or replace function public.check_agent_session(
  p_badge text, p_pin text, p_session_epoch uuid
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_epoch uuid;
begin
  select agent_session_epoch into v_epoch
  from public.app_control where id = true for share;
  if p_session_epoch is distinct from v_epoch then return false; end if;
  return exists(select 1 from public.authenticate_agent(p_badge, p_pin));
end;
$$;

create or replace function public.get_agent_routes_session(
  p_badge text, p_pin text, p_session_epoch uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.check_agent_session(p_badge, p_pin, p_session_epoch) then
    raise exception 'Agent session expired' using errcode = '28000';
  end if;
  return public.get_agent_routes(p_badge, p_pin);
end;
$$;

create or replace function public.sync_agent_tour_session(
  p_badge text, p_pin text, p_session_epoch uuid, p_tour jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.check_agent_session(p_badge, p_pin, p_session_epoch) then
    raise exception 'Agent session expired' using errcode = '28000';
  end if;
  return public.sync_agent_tour_for_site(p_badge, p_pin, p_tour);
end;
$$;

create or replace function public.manager_purge_activity_history_v2()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deleted bigint;
  v_manager_count bigint;
  v_user_id uuid;
begin
  v_user_id := auth.uid();
  select count(*) into v_manager_count
  from public.manager_users
  where user_id = v_user_id;

  if v_user_id is null or v_manager_count <> 1 then
    raise exception 'Manager access required' using errcode = '42501';
  end if;

  insert into public.app_control (id)
  values (true)
  on conflict (id) do nothing;

  perform 1 from public.app_control where id = true for update;

  select count(*) into v_deleted from public.tours;
  truncate table public.incidents, public.tour_scans, public.tours;

  update public.app_control
  set agent_session_epoch = gen_random_uuid(), activity_reset_at = current_timestamp
  where id = true;

  return jsonb_build_object('ok', true, 'deleted_count', v_deleted);
end;
$$;

create or replace function public.manager_clear_activity_history()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  v_result := public.manager_purge_activity_history_v2();
  return coalesce((v_result->>'deleted_count')::bigint, 0);
end;
$$;

revoke all on table public.app_control from public, anon, authenticated;
revoke all on function public.authenticate_agent(text, text) from public, anon, authenticated;
revoke all on function public.get_agent_route(text, text) from public, anon, authenticated;
revoke all on function public.get_agent_routes(text, text) from public, anon, authenticated;
revoke all on function public.sync_agent_tour(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_agent_tour_for_site(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.authenticate_agent_session(text, text) from public;
revoke all on function public.check_agent_session(text, text, uuid) from public;
revoke all on function public.get_agent_routes_session(text, text, uuid) from public;
revoke all on function public.sync_agent_tour_session(text, text, uuid, jsonb) from public;
revoke all on function public.manager_purge_activity_history_v2() from public, anon;
revoke all on function public.manager_clear_activity_history() from public, anon;
grant execute on function public.authenticate_agent_session(text, text) to anon, authenticated;
grant execute on function public.check_agent_session(text, text, uuid) to anon, authenticated;
grant execute on function public.get_agent_routes_session(text, text, uuid) to anon, authenticated;
grant execute on function public.sync_agent_tour_session(text, text, uuid, jsonb) to anon, authenticated;
grant execute on function public.manager_purge_activity_history_v2() to authenticated;
grant execute on function public.manager_clear_activity_history() to authenticated;

notify pgrst, 'reload schema';
commit;
