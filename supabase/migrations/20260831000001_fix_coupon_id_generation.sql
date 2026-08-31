-- Fix Coupon ID generation for the managed Supabase Postgres runtime.
create or replace function public.issue_coupon(
  p_device_id uuid,
  p_ip_hash text,
  p_user_agent_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_existing public.coupons%rowtype;
  v_coupon_id text;
begin
  if p_device_id is null then
    raise exception using errcode = '22023', message = 'invalid_device_id';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('machida:issue:' || p_device_id::text, 0)
  );

  if (
    select count(*)
    from public.coupon_rate_events
    where device_id = p_device_id
      and event_type in ('STATUS_CHECK', 'COUPON_ISSUE')
      and event_at >= v_now - interval '10 minutes'
  ) >= 12 then
    insert into public.coupon_rate_events
      (event_type, device_id, ip_hash, user_agent_hash, success, metadata)
    values
      ('RATE_LIMITED', p_device_id, p_ip_hash, p_user_agent_hash, false,
       jsonb_build_object('scope', 'coupon_issue'));
    return jsonb_build_object('status', 'RATE_LIMITED');
  end if;

  select * into v_existing
  from public.coupons
  where device_id = p_device_id
    and status = 'REDEEMED'
    and available_again_at > v_now
  order by redeemed_at desc
  limit 1;

  if found then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash, success, metadata)
    values
      ('COUPON_LOCKED', p_device_id, v_existing.coupon_id, p_ip_hash,
       p_user_agent_hash, false, jsonb_build_object('scope', '14_day_lock'));
    return jsonb_build_object(
      'status', 'LOCKED',
      'coupon_id', v_existing.coupon_id,
      'available_again_at', v_existing.available_again_at
    );
  end if;

  select * into v_existing
  from public.coupons
  where device_id = p_device_id
    and status = 'ACTIVE'
  order by created_at desc
  limit 1;

  if found then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash, success, metadata)
    values
      ('STATUS_CHECK', p_device_id, v_existing.coupon_id, p_ip_hash,
       p_user_agent_hash, true, jsonb_build_object('scope', 'existing_active'));
    return jsonb_build_object(
      'status', 'ACTIVE',
      'coupon_id', v_existing.coupon_id,
      'created_at', v_existing.created_at
    );
  end if;

  loop
    v_coupon_id := 'MS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4))
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
    begin
      insert into public.coupons (coupon_id, device_id, status, created_at, updated_at)
      values (v_coupon_id, p_device_id, 'ACTIVE', v_now, v_now)
      returning * into v_existing;
      exit;
    exception when unique_violation then
      -- Retry only the generated public Coupon ID; the uniqueness collision is rare.
    end;
  end loop;

  insert into public.coupon_rate_events
    (event_type, device_id, coupon_id, ip_hash, user_agent_hash, success, metadata)
  values
    ('COUPON_ISSUE', p_device_id, v_existing.coupon_id, p_ip_hash,
     p_user_agent_hash, true, jsonb_build_object('scope', 'new_session'));

  return jsonb_build_object(
    'status', 'ACTIVE',
    'coupon_id', v_existing.coupon_id,
    'created_at', v_existing.created_at
  );
end;
$$;

revoke execute on function public.issue_coupon(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_coupon(uuid, text, text) to service_role;
