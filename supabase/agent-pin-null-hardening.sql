-- Apply LAST, after api-grants.sql and remembered-agent-sessions.sql.
-- Non-destructive: replace PIN validation functions without changing stored PINs or sessions.
-- Reapplying older migrations after this file can restore vulnerable function definitions.
begin;

create or replace function public.authenticate_agent(p_badge text, p_pin text)
returns table (id text, name text, badge text, site_id uuid, site_name text, all_sites_access boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_agent public.agents%rowtype;
begin
  -- Reject malformed input before SQL NULL comparisons can bypass authentication.
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then return; end if;
  select a.* into v_agent from public.agents a
  where lower(a.badge) = lower(trim(p_badge)) limit 1;
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

create or replace function public.create_remembered_agent_session(p_badge text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_agent record; v_token text; v_epoch uuid; v_pin_hash text;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then return null; end if;
  select * into v_agent from public.authenticate_agent(p_badge, p_pin) limit 1;
  if not found then return null; end if;
  select pin_hash into v_pin_hash from public.agents where id = v_agent.id;
  -- A concurrent PIN reset must not let an old PIN mint a token for the new hash.
  if v_pin_hash is null or v_pin_hash is distinct from extensions.crypt(p_pin, v_pin_hash) then return null; end if;
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

create or replace function public.manager_create_agent(
  p_name text, p_badge text, p_pin text, p_site_id uuid, p_all_sites_access boolean default false
)
returns table (id text, name text, badge text, active boolean, created_at timestamptz, site_id uuid, all_sites_access boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare v_id text;
begin
  if not public.is_current_user_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if length(trim(p_name)) < 2 or length(trim(p_badge)) < 2 then raise exception 'Name and badge are required' using errcode = '22023'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must contain exactly 6 digits' using errcode = '22023'; end if;
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

create or replace function public.manager_reset_agent_pin(p_agent_id text, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_current_user_manager() then
    raise exception 'Manager access required' using errcode = '42501';
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must contain exactly 6 digits' using errcode = '22023';
  end if;

  update public.agents
  set
    pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
    failed_login_attempts = 0,
    locked_until = null
  where id = p_agent_id;

  return found;
end;
$$;

-- Keep raw authentication internal; browsers use the session RPCs.
revoke all on function public.authenticate_agent(text, text) from public, anon, authenticated;
revoke all on function public.create_remembered_agent_session(text, text) from public, anon, authenticated;
grant execute on function public.create_remembered_agent_session(text, text) to anon, authenticated;
revoke all on function public.manager_create_agent(text, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.manager_create_agent(text, text, text, uuid, boolean) to authenticated;
revoke all on function public.manager_reset_agent_pin(text, text) from public, anon, authenticated;
grant execute on function public.manager_reset_agent_pin(text, text) to authenticated;

notify pgrst, 'reload schema';
commit;

