-- Multi-site agent access and safe deletion of assigned sites.
-- Run once after manager-deletions.sql.
begin;

alter table public.agents add column if not exists all_sites_access boolean not null default false;
alter table public.agents alter column site_id drop not null;
alter table public.agents drop constraint if exists agents_site_id_fkey;
alter table public.agents add constraint agents_site_id_fkey
  foreign key (site_id) references public.sites(id) on delete set null;

drop function if exists public.authenticate_agent(text, text);
create function public.authenticate_agent(p_badge text, p_pin text)
returns table (id text, name text, badge text, site_id uuid, site_name text, all_sites_access boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_agent public.agents%rowtype;
begin
  select a.* into v_agent from public.agents a
  where lower(a.badge) = lower(trim(p_badge)) limit 1;
  if not found or not v_agent.active or v_agent.pin_hash is null then return; end if;
  if v_agent.locked_until is not null and v_agent.locked_until > now() then return; end if;
  if v_agent.pin_hash <> extensions.crypt(p_pin, v_agent.pin_hash) then
    update public.agents set failed_login_attempts = failed_login_attempts + 1,
      locked_until = case when failed_login_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where public.agents.id = v_agent.id;
    return;
  end if;
  if not v_agent.all_sites_access and not exists (
    select 1 from public.sites s where s.id = v_agent.site_id and s.active
  ) then return; end if;
  update public.agents set failed_login_attempts = 0, locked_until = null where public.agents.id = v_agent.id;
  return query select v_agent.id, v_agent.name, v_agent.badge, v_agent.site_id,
    (select s.name from public.sites s where s.id = v_agent.site_id), v_agent.all_sites_access;
end;
$$;
revoke all on function public.authenticate_agent(text, text) from public;
grant execute on function public.authenticate_agent(text, text) to anon, authenticated;

create or replace function public.get_agent_routes(p_badge text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_agent record; v_result jsonb;
begin
  select * into v_agent from public.authenticate_agent(p_badge, p_pin) limit 1;
  if not found then raise exception 'Invalid agent credentials' using errcode = '28000'; end if;
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
revoke all on function public.get_agent_routes(text, text) from public;
grant execute on function public.get_agent_routes(text, text) to anon, authenticated;

drop function if exists public.manager_create_agent(text, text, text, uuid);
create function public.manager_create_agent(
  p_name text, p_badge text, p_pin text, p_site_id uuid, p_all_sites_access boolean default false
)
returns table (id text, name text, badge text, active boolean, created_at timestamptz, site_id uuid, all_sites_access boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_id text;
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 or length(trim(p_badge)) < 2 then raise exception 'Name and badge are required' using errcode = '22023'; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must contain exactly 6 digits' using errcode = '22023'; end if;
  if not coalesce(p_all_sites_access, false) and not exists (
    select 1 from public.sites s where s.id = p_site_id and s.active
  ) then raise exception 'Active site required' using errcode = '22023'; end if;
  v_id := 'agent-' || substr(md5(random()::text || clock_timestamp()::text), 1, 16);
  insert into public.agents (id, name, badge, active, pin_hash, site_id, all_sites_access)
  values (v_id, left(trim(p_name), 80), left(trim(p_badge), 32), true,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
    case when p_all_sites_access then null else p_site_id end, coalesce(p_all_sites_access, false));
  return query select a.id, a.name, a.badge, a.active, a.created_at, a.site_id, a.all_sites_access
  from public.agents a where a.id = v_id;
end;
$$;
revoke all on function public.manager_create_agent(text, text, text, uuid, boolean) from public;
grant execute on function public.manager_create_agent(text, text, text, uuid, boolean) to authenticated;

create or replace function public.manager_set_agent_access(
  p_agent_id text, p_site_id uuid, p_all_sites_access boolean
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if exists (select 1 from public.tours where agent_id = p_agent_id and status = 'active') then
    raise exception 'Active patrol prevents access changes' using errcode = '55000';
  end if;
  if not coalesce(p_all_sites_access, false) and not exists (
    select 1 from public.sites s where s.id = p_site_id and s.active
  ) then raise exception 'Active site required' using errcode = '22023'; end if;
  update public.agents set
    site_id = case when p_all_sites_access then null else p_site_id end,
    all_sites_access = coalesce(p_all_sites_access, false), active = true
  where id = p_agent_id;
  return found;
end;
$$;
revoke all on function public.manager_set_agent_access(text, uuid, boolean) from public, anon;
grant execute on function public.manager_set_agent_access(text, uuid, boolean) to authenticated;

create or replace function public.manager_delete_site(p_site_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_found boolean;
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  if exists (select 1 from public.tours where site_id = p_site_id and status = 'active') then
    raise exception 'Active patrol prevents deletion' using errcode = '55000';
  end if;
  select exists(select 1 from public.sites where id = p_site_id) into v_found;
  if not v_found then return false; end if;
  update public.tours t set site_name = s.name from public.sites s
  where s.id = p_site_id and t.site_id = s.id;
  update public.agents set active = false, site_id = null
  where site_id = p_site_id and not all_sites_access;
  delete from public.sites where id = p_site_id;
  return true;
end;
$$;
revoke all on function public.manager_delete_site(uuid) from public, anon;
grant execute on function public.manager_delete_site(uuid) to authenticated;

create or replace function public.sync_agent_tour_for_site(p_badge text, p_pin text, p_tour jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_agent record;
  v_site_id uuid;
  v_result jsonb;
begin
  select * into v_agent from public.authenticate_agent(p_badge, p_pin) limit 1;
  if not found then raise exception 'Invalid agent credentials' using errcode = '28000'; end if;
  v_site_id := nullif(p_tour->>'siteId', '')::uuid;
  if v_site_id is null or not exists (
    select 1 from public.sites s
    where s.id = v_site_id and s.active
      and (v_agent.all_sites_access or s.id = v_agent.site_id)
  ) then raise exception 'Agent is not authorized for this site' using errcode = '42501'; end if;

  -- The original validated synchronizer uses agents.site_id. Serialize this
  -- short compatibility bridge so all-site agents can safely choose a route.
  perform pg_advisory_xact_lock(hashtext(v_agent.id));
  if v_agent.all_sites_access then
    update public.agents set site_id = v_site_id where id = v_agent.id;
  end if;
  v_result := public.sync_agent_tour(p_badge, p_pin, p_tour);
  if v_agent.all_sites_access then
    update public.agents set site_id = null where id = v_agent.id;
  end if;
  return v_result;
end;
$$;
revoke all on function public.sync_agent_tour_for_site(text, text, jsonb) from public;
grant execute on function public.sync_agent_tour_for_site(text, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
