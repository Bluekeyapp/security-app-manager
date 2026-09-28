-- Run after operations-upgrade.sql. Keeps recorded patrols, scans and incidents.
begin;

alter table public.agents add column if not exists all_sites_access boolean not null default false;
alter table public.agents alter column site_id drop not null;
alter table public.agents drop constraint if exists agents_site_id_fkey;
alter table public.agents add constraint agents_site_id_fkey
  foreign key (site_id) references public.sites(id) on delete set null;

alter table public.tours add column if not exists site_name text;
update public.tours t set site_name = s.name
from public.sites s where t.site_id = s.id and t.site_name is null;

create or replace function public.manager_delete_agent(p_agent_id text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;
  -- Serialize deletion with authentication and patrol writes before checking status.
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  if exists (select 1 from public.tours where agent_id = p_agent_id and status = 'active') then
    raise exception 'Active patrol prevents deletion' using errcode = '55000';
  end if;
  delete from public.agents where id = p_agent_id;
  return found;
end;
$$;

create or replace function public.manager_delete_site(p_site_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_found boolean;
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  if exists (select 1 from public.tours where site_id = p_site_id and status = 'active') then
    raise exception 'Active patrol prevents deletion' using errcode = '55000';
  end if;
  select exists(select 1 from public.sites where id = p_site_id) into v_found;
  if not v_found then return false; end if;
  update public.tours t set site_name = s.name
  from public.sites s where s.id = p_site_id and t.site_id = s.id;
  update public.agents set active = false, site_id = null
  where site_id = p_site_id and not all_sites_access;
  delete from public.sites where id = p_site_id;
  return true;
end;
$$;

create or replace function public.manager_delete_checkpoint(p_checkpoint_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_point public.checkpoints%rowtype;
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  select * into v_point from public.checkpoints where id = p_checkpoint_id;
  if not found then return false; end if;
  if v_point.kind = 'start' then
    raise exception 'Starting post cannot be deleted separately' using errcode = '22023';
  end if;
  if exists (select 1 from public.tours where site_id = v_point.site_id and status = 'active') then
    raise exception 'Active patrol prevents deletion' using errcode = '55000';
  end if;
  delete from public.checkpoints where id = p_checkpoint_id;
  return found;
end;
$$;

revoke all on function public.manager_delete_agent(text) from public, anon;
revoke all on function public.manager_delete_site(uuid) from public, anon;
revoke all on function public.manager_delete_checkpoint(text) from public, anon;
grant execute on function public.manager_delete_agent(text) to authenticated;
grant execute on function public.manager_delete_site(uuid) to authenticated;
grant execute on function public.manager_delete_checkpoint(text) to authenticated;

notify pgrst, 'reload schema';
commit;
