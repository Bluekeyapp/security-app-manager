-- Apply after qr-management.sql. The browser reads these tables as an
-- authenticated manager; agents use the explicitly granted session RPCs.
-- RLS manager policies remain the row-level gate for every SELECT.
begin;

revoke all on table
  public.agents,
  public.sites,
  public.checkpoints,
  public.tours,
  public.tour_scans,
  public.incidents,
  public.manager_users
from public, anon, authenticated;

grant select on table
  public.agents,
  public.sites,
  public.checkpoints,
  public.tours,
  public.tour_scans,
  public.incidents
to authenticated;

-- Older deployments can retain direct anon EXECUTE grants even after a
-- revoke from PUBLIC. Every manager RPC must require an authenticated role.
do $$
declare v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (left(p.proname, 8) = 'manager_' or p.proname = 'is_current_user_manager')
  loop
    execute format('revoke all on function %s from public, anon', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
