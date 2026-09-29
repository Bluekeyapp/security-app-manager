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

notify pgrst, 'reload schema';
commit;
