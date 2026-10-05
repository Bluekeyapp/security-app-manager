-- Apply after tour-write-ownership-hardening.sql.
-- Preserve the existing 5-attempt / 15-minute policy, PINs, sessions and patrols.
-- PostgREST must commit normal requests (no client-controlled rollback override).
-- PIN rejections use response.status instead of RAISE so counters are committed.
-- Serialize each agent's checks with a row lock before testing its lock state.
begin;

create or replace function public.authenticate_agent(p_badge text, p_pin text)
returns table (id text, name text, badge text, site_id uuid, site_name text, all_sites_access boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_agent public.agents%rowtype;
begin
  -- Reject malformed input before SQL NULL comparisons can bypass authentication.
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then return; end if;
  -- Take the writer table lock before the row lock, as UPDATE does, so manager
  -- deletion locks cannot slip between these and cause a lock-upgrade deadlock.
  lock table public.agents in row exclusive mode;
  select a.* into v_agent from public.agents a
  where lower(a.badge) = lower(trim(p_badge)) limit 1 for update;
  if not found or not v_agent.active or v_agent.pin_hash is null then return; end if;
  if v_agent.locked_until is not null and v_agent.locked_until > now() then return; end if;
  if v_agent.pin_hash is distinct from extensions.crypt(p_pin, v_agent.pin_hash) then
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

create or replace function public.get_agent_routes_session(
  p_badge text, p_pin text, p_session_epoch uuid
)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.check_agent_session(p_badge, p_pin, p_session_epoch) then
    -- Return a failure response without rolling back the failed-PIN counter.
    -- Supabase clients still receive an HTTP 401 error with code 28000.
    perform set_config('response.status', '401', true);
    return jsonb_build_object('code', '28000', 'message', 'Agent session expired');
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
    -- Return a failure response without rolling back the failed-PIN counter.
    -- Supabase clients still receive an HTTP 401 error with code 28000.
    perform set_config('response.status', '401', true);
    return jsonb_build_object('code', '28000', 'message', 'Agent session expired');
  end if;
  return public.sync_agent_tour_for_site(p_badge, p_pin, p_tour);
end;
$$;

-- Raw authentication remains internal; only the protected session RPCs are exposed.
revoke all on function public.authenticate_agent(text, text) from public, anon, authenticated;
revoke all on function public.get_agent_route(text, text) from public, anon, authenticated;
revoke all on function public.get_agent_routes(text, text) from public, anon, authenticated;
revoke all on function public.sync_agent_tour(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_agent_tour_for_site(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.get_agent_routes_session(text, text, uuid) from public, anon, authenticated;
revoke all on function public.sync_agent_tour_session(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.get_agent_routes_session(text, text, uuid) to anon, authenticated;
grant execute on function public.sync_agent_tour_session(text, text, uuid, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
