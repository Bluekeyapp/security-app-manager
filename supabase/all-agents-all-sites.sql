-- Run after multi-site-access.sql. All agents can patrol every active site.
begin;

-- Preserve disabled accounts and the site on historical/current tours.
update public.agents set all_sites_access = true;
alter table public.agents alter column all_sites_access set default true;
alter table public.agents drop constraint if exists agents_all_sites_access_required;
alter table public.agents add constraint agents_all_sites_access_required
  check (all_sites_access = true);

-- Site assignment is no longer a manager operation.
drop function if exists public.manager_set_agent_access(text, uuid, boolean);

-- site_id remains an internal bridge for the existing validated synchronizer.
-- It must not be cleared here while old phones may have pending patrols.
notify pgrst, 'reload schema';
commit;
