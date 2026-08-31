-- Machida Shoten QR Coupon: isolated coupon state and server-side redemption.
-- This migration is intended for project ref qzlaqnteaxzkgqfhcxtu only.

create extension if not exists pgcrypto;

create table public.coupons (
  id bigint generated always as identity primary key,
  coupon_id text not null unique,
  device_id uuid not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default timezone('utc', now()),
  redeemed_at timestamptz,
  available_again_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint coupons_coupon_id_format_check
    check (coupon_id ~ '^MS-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  constraint coupons_status_check
    check (status in ('ACTIVE', 'REDEEMED')),
  constraint coupons_redemption_fields_check
    check (
      (status = 'ACTIVE' and redeemed_at is null and available_again_at is null)
      or
      (status = 'REDEEMED'
        and redeemed_at is not null
        and available_again_at = redeemed_at + interval '14 days')
    )
);

create table public.coupon_rate_events (
  id bigint generated always as identity primary key,
  event_at timestamptz not null default timezone('utc', now()),
  event_type text not null,
  rate_key_hash text,
  device_id uuid,
  coupon_id text,
  ip_hash text,
  user_agent_hash text,
  staff_action_id uuid,
  success boolean,
  metadata jsonb not null default '{}'::jsonb,
  constraint coupon_rate_events_type_check
    check (event_type in (
      'STATUS_CHECK', 'COUPON_ISSUE', 'RATE_LIMITED', 'COUPON_LOCKED',
      'REDEEM_ATTEMPT', 'REDEEM_SUCCESS', 'REDEEM_REJECTED',
      'STAFF_FAILURE', 'STAFF_SUCCESS', 'STAFF_LOCKED', 'REVIEW_REQUIRED'
    )),
  constraint coupon_rate_events_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create table public.coupon_staff_lockouts (
  rate_key_hash text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  constraint coupon_staff_lockouts_failed_count_check check (failed_count >= 0)
);

create index coupons_device_created_idx
  on public.coupons (device_id, created_at desc);

create index coupons_device_redeemed_idx
  on public.coupons (device_id, redeemed_at desc)
  where status = 'REDEEMED';

create index coupon_rate_events_device_time_idx
  on public.coupon_rate_events (device_id, event_at desc);

create index coupon_rate_events_coupon_time_idx
  on public.coupon_rate_events (coupon_id, event_at desc);

create index coupon_rate_events_ip_time_idx
  on public.coupon_rate_events (ip_hash, event_at desc);

create index coupon_rate_events_type_time_idx
  on public.coupon_rate_events (event_type, event_at desc);

create unique index coupon_rate_events_action_type_uidx
  on public.coupon_rate_events (staff_action_id, event_type)
  where staff_action_id is not null;

alter table public.coupons enable row level security;
alter table public.coupon_rate_events enable row level security;
alter table public.coupon_staff_lockouts enable row level security;

revoke all on table public.coupons from public, anon, authenticated;
revoke all on table public.coupon_rate_events from public, anon, authenticated;
revoke all on table public.coupon_staff_lockouts from public, anon, authenticated;
grant all on table public.coupons to service_role;
grant all on table public.coupon_rate_events to service_role;
grant all on table public.coupon_staff_lockouts to service_role;
grant usage, select on sequence public.coupons_id_seq to service_role;
grant usage, select on sequence public.coupon_rate_events_id_seq to service_role;

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

create or replace function public.record_staff_attempt(
  p_rate_key_hash text,
  p_device_id uuid,
  p_coupon_id text,
  p_staff_action_id uuid,
  p_ip_hash text,
  p_user_agent_hash text,
  p_success boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lock public.coupon_staff_lockouts%rowtype;
  v_failed_count integer;
  v_locked_until timestamptz;
begin
  if p_rate_key_hash is null or p_staff_action_id is null then
    raise exception using errcode = '22023', message = 'invalid_staff_attempt';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('machida:staff:' || p_rate_key_hash, 0)
  );

  insert into public.coupon_staff_lockouts (rate_key_hash, updated_at)
  values (p_rate_key_hash, v_now)
  on conflict (rate_key_hash) do nothing;

  select * into v_lock
  from public.coupon_staff_lockouts
  where rate_key_hash = p_rate_key_hash
  for update;

  if v_lock.locked_until is not null and v_lock.locked_until > v_now then
    insert into public.coupon_rate_events
      (event_type, rate_key_hash, device_id, coupon_id, ip_hash,
       user_agent_hash, staff_action_id, success, metadata)
    values
      ('STAFF_LOCKED', p_rate_key_hash, p_device_id, p_coupon_id, p_ip_hash,
       p_user_agent_hash, p_staff_action_id, false,
       jsonb_build_object('scope', 'staff_code'));
    return jsonb_build_object(
      'status', 'STAFF_LOCKED',
      'locked_until', v_lock.locked_until
    );
  end if;

  if p_success then
    update public.coupon_staff_lockouts
    set failed_count = 0,
        locked_until = null,
        updated_at = v_now
    where rate_key_hash = p_rate_key_hash;

    insert into public.coupon_rate_events
      (event_type, rate_key_hash, device_id, coupon_id, ip_hash,
       user_agent_hash, staff_action_id, success, metadata)
    values
      ('STAFF_SUCCESS', p_rate_key_hash, p_device_id, p_coupon_id, p_ip_hash,
       p_user_agent_hash, p_staff_action_id, true,
       jsonb_build_object('scope', 'staff_code'));
    return jsonb_build_object('status', 'STAFF_OK');
  end if;

  v_failed_count := coalesce(v_lock.failed_count, 0) + 1;
  v_locked_until := case
    when v_failed_count >= 5 then v_now + interval '5 minutes'
    else null
  end;

  update public.coupon_staff_lockouts
  set failed_count = v_failed_count,
      locked_until = v_locked_until,
      last_failed_at = v_now,
      updated_at = v_now
  where rate_key_hash = p_rate_key_hash;

  insert into public.coupon_rate_events
    (event_type, rate_key_hash, device_id, coupon_id, ip_hash,
     user_agent_hash, staff_action_id, success, metadata)
  values
    ('STAFF_FAILURE', p_rate_key_hash, p_device_id, p_coupon_id, p_ip_hash,
     p_user_agent_hash, p_staff_action_id, false,
     jsonb_build_object('scope', 'staff_code'));

  return jsonb_build_object(
    'status', 'INVALID_STAFF_CODE',
    'failed_attempts', v_failed_count,
    'locked_until', v_locked_until
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

  if v_coupon.status <> 'ACTIVE' then
    return jsonb_build_object(
      'status', 'ALREADY_REDEEMED',
      'coupon_id', v_coupon.coupon_id,
      'redeemed_at', v_coupon.redeemed_at,
      'available_again_at', v_coupon.available_again_at
    );
  end if;

  if not p_group_confirmed or not p_no_other_promotion then
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
revoke execute on function public.record_staff_attempt(text, uuid, text, uuid, text, text, boolean)
  from public, anon, authenticated;
revoke execute on function public.redeem_coupon(text, uuid, uuid, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_coupon(uuid, text, text) to service_role;
grant execute on function public.record_staff_attempt(text, uuid, text, uuid, text, text, boolean)
  to service_role;
grant execute on function public.redeem_coupon(text, uuid, uuid, text, text, boolean, boolean)
  to service_role;

comment on table public.coupons is
  'Anonymous coupon sessions. Access is restricted to the coupon Edge Function service role.';
comment on table public.coupon_rate_events is
  'Hashed abuse-detection events; never store staff codes, raw IPs, or raw user agents.';
comment on table public.coupon_staff_lockouts is
  'Hashed staff-attempt keys with a short lockout window.';
