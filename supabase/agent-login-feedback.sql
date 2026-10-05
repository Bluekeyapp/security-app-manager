-- Apply after agent-pin-attempts-hardening.sql, before updating SAB Agent.
-- Additive endpoint: existing clients and session RPCs retain their contracts.
begin;

create or replace function public.agent_login(p_badge text, p_pin text, p_remember boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_login jsonb; v_locked_until timestamptz;
begin
  if p_remember then
    v_login := public.create_remembered_agent_session(p_badge, p_pin);
  else
    select to_jsonb(a) into v_login
    from public.authenticate_agent_session(p_badge, p_pin) a limit 1;
  end if;
  if v_login is not null then
    return jsonb_build_object('ok', true, 'agent', v_login);
  end if;
  -- Authentication holds the agent row lock through this transaction.
  -- Return normally so rejected PIN attempts are committed by PostgREST.
  if p_pin is not null and p_pin ~ '^[0-9]{6}$' then
    select a.locked_until into v_locked_until from public.agents a
    where lower(a.badge) = lower(trim(p_badge)) and a.active and a.pin_hash is not null
    limit 1;
    if v_locked_until > now() then
      return jsonb_build_object('ok', false, 'reason', 'locked',
        'retry_after_seconds', ceil(extract(epoch from (v_locked_until - now())))::integer);
    end if;
  end if;
  return jsonb_build_object('ok', false, 'reason', 'invalid_credentials');
end;
$$;

revoke all on function public.agent_login(text, text, boolean) from public, anon, authenticated;
grant execute on function public.agent_login(text, text, boolean) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
