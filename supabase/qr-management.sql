-- Run after manager-deletions.sql. Allow replacing a site's starting QR.
begin;

drop function if exists public.manager_set_checkpoint_active(text, boolean);

create or replace function public.manager_delete_checkpoint(p_checkpoint_id text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_point public.checkpoints%rowtype;
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  select * into v_point from public.checkpoints where id = p_checkpoint_id;
  if not found then return false; end if;
  if exists (select 1 from public.tours where site_id = v_point.site_id and status = 'active') then
    raise exception 'Active patrol prevents deletion' using errcode = '55000';
  end if;
  delete from public.checkpoints where id = p_checkpoint_id;
  return found;
end;
$$;

create or replace function public.manager_create_starting_post(p_site_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;
  lock table public.agents, public.sites, public.checkpoints, public.tours in share row exclusive mode;
  if not exists (select 1 from public.sites where id = p_site_id and active) then
    raise exception 'Active site required' using errcode = '22023';
  end if;
  if exists (select 1 from public.tours where site_id = p_site_id and status = 'active') then
    raise exception 'Active patrol prevents changes' using errcode = '55000';
  end if;
  if exists (select 1 from public.checkpoints where site_id = p_site_id and kind = 'start') then
    raise exception 'Starting post already exists' using errcode = '22023';
  end if;
  insert into public.checkpoints (id, site_id, label, kind, qr_payload, sort_order, active)
  values ('start-' || replace(gen_random_uuid()::text, '-', ''), p_site_id, 'Poste A', 'start',
    'SAB:' || upper(replace(gen_random_uuid()::text, '-', '')), 0, true);
  return true;
end;
$$;

revoke all on function public.manager_delete_checkpoint(text) from public, anon;
revoke all on function public.manager_create_starting_post(uuid) from public, anon;
grant execute on function public.manager_delete_checkpoint(text) to authenticated;
grant execute on function public.manager_create_starting_post(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
