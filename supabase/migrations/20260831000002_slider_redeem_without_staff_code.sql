-- Retire staff-code redemption for the dedicated Machida coupon project.
-- The legacy coupon_staff_lockouts table and record_staff_attempt function are
-- intentionally retained for rollback/audit, but no active API path calls them.

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
      'redeemed_at', v_existing.redeemed_at,
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

create or replace function public.redeem_coupon(
  p_coupon_id text,
  p_device_id uuid,
  p_staff_action_id uuid,
  p_ip_hash text,
  p_user_agent_hash text,
  p_group_confirmed boolean,
  p_no_other_promotion boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_coupon public.coupons%rowtype;
  v_prior_event public.coupon_rate_events%rowtype;
  v_attempt_count integer;
begin
  if p_coupon_id is null or p_device_id is null or p_staff_action_id is null then
    raise exception using errcode = '22023', message = 'invalid_redemption';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('machida:coupon:' || p_coupon_id, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('machida:device:' || p_device_id::text, 0)
  );

  select * into v_coupon
  from public.coupons
  where coupon_id = p_coupon_id
  for update;

  if not found or v_coupon.device_id <> p_device_id then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
       staff_action_id, success, metadata)
    values
      ('REDEEM_REJECTED', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
       p_staff_action_id, false, jsonb_build_object('reason', 'invalid_coupon'));
    return jsonb_build_object('status', 'INVALID_COUPON');
  end if;

  -- A retry with the same slider action is idempotent. This also makes a
  -- successful redemption recoverable when the response was lost in transit.
  select * into v_prior_event
  from public.coupon_rate_events
  where staff_action_id = p_staff_action_id
  order by event_at desc, id desc
  limit 1;

  if found then
    if v_prior_event.device_id is distinct from p_device_id
      or v_prior_event.coupon_id is distinct from p_coupon_id then
      return jsonb_build_object('status', 'DUPLICATE_REQUEST');
    end if;
    if v_prior_event.event_type = 'REDEEM_SUCCESS'
      and v_coupon.status = 'REDEEMED' then
      return jsonb_build_object(
        'status', 'REDEEMED',
        'coupon_id', v_coupon.coupon_id,
        'redeemed_at', v_coupon.redeemed_at,
        'available_again_at', v_coupon.available_again_at
      );
    end if;
    if v_prior_event.event_type = 'REVIEW_REQUIRED' then
      return jsonb_build_object('status', 'REVIEW_REQUIRED');
    end if;
    return jsonb_build_object('status', 'DUPLICATE_REQUEST');
  end if;

  if v_coupon.status <> 'ACTIVE' then
    return jsonb_build_object(
      'status', 'ALREADY_REDEEMED',
      'coupon_id', v_coupon.coupon_id,
      'redeemed_at', v_coupon.redeemed_at,
      'available_again_at', v_coupon.available_again_at
    );
  end if;

  if coalesce(p_group_confirmed, false) is not true
    or coalesce(p_no_other_promotion, false) is not true then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
       staff_action_id, success, metadata)
    values
      ('REVIEW_REQUIRED', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
       p_staff_action_id, false, jsonb_build_object('reason', 'staff_check_incomplete'));
    return jsonb_build_object('status', 'REVIEW_REQUIRED');
  end if;

  insert into public.coupon_rate_events
    (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
     staff_action_id, success, metadata)
  values
    ('REDEEM_ATTEMPT', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
     p_staff_action_id, true, jsonb_build_object('scope', 'redemption'));

  select count(*) into v_attempt_count
  from public.coupon_rate_events
  where device_id = p_device_id
    and event_type = 'REDEEM_ATTEMPT'
    and event_at >= v_now - interval '10 minutes';
  if v_attempt_count > 3 then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
       staff_action_id, success, metadata)
    values
      ('REVIEW_REQUIRED', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
       p_staff_action_id, false, jsonb_build_object('reason', 'device_rate_limit'));
    return jsonb_build_object('status', 'REVIEW_REQUIRED');
  end if;

  select count(*) into v_attempt_count
  from public.coupon_rate_events
  where coupon_id = p_coupon_id
    and event_type = 'REDEEM_ATTEMPT'
    and event_at >= v_now - interval '10 minutes';
  if v_attempt_count > 2 then
    insert into public.coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
       staff_action_id, success, metadata)
    values
      ('REVIEW_REQUIRED', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
       p_staff_action_id, false, jsonb_build_object('reason', 'coupon_rate_limit'));
    return jsonb_build_object('status', 'REVIEW_REQUIRED');
  end if;

  if p_ip_hash is not null then
    select count(*) into v_attempt_count
    from public.coupon_rate_events
    where ip_hash = p_ip_hash
      and event_type = 'REDEEM_ATTEMPT'
      and event_at >= v_now - interval '10 minutes';
    if v_attempt_count > 12 then
      insert into public.coupon_rate_events
        (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
         staff_action_id, success, metadata)
      values
        ('REVIEW_REQUIRED', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
         p_staff_action_id, false, jsonb_build_object('reason', 'network_rate_limit'));
      return jsonb_build_object('status', 'REVIEW_REQUIRED');
    end if;
  end if;

  update public.coupons
  set status = 'REDEEMED',
      redeemed_at = v_now,
      available_again_at = v_now + interval '14 days',
      updated_at = v_now
  where id = v_coupon.id
    and status = 'ACTIVE'
  returning * into v_coupon;

  if not found then
    return jsonb_build_object('status', 'ALREADY_REDEEMED');
  end if;

  insert into public.coupon_rate_events
    (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
     staff_action_id, success, metadata)
  values
    ('REDEEM_SUCCESS', p_device_id, p_coupon_id, p_ip_hash, p_user_agent_hash,
     p_staff_action_id, true, jsonb_build_object('scope', 'redemption'));

  return jsonb_build_object(
    'status', 'REDEEMED',
    'coupon_id', v_coupon.coupon_id,
    'redeemed_at', v_coupon.redeemed_at,
    'available_again_at', v_coupon.available_again_at
  );
end;
$$;

revoke execute on function public.issue_coupon(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.redeem_coupon(text, uuid, uuid, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_coupon(uuid, text, text) to service_role;
grant execute on function public.redeem_coupon(text, uuid, uuid, text, text, boolean, boolean)
  to service_role;

comment on table public.coupon_staff_lockouts is
  'Legacy staff-code lockout table retained for rollback/audit; no active API path uses it.';
