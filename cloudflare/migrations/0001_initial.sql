-- Machida QR Coupon D1 schema.
-- This migration is for the dedicated Cloudflare D1 database only.

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id TEXT NOT NULL UNIQUE
    CHECK (
      length(coupon_id) = 12
      AND substr(coupon_id, 1, 3) = 'MS-'
      AND substr(coupon_id, 8, 1) = '-'
    ),
  device_id TEXT NOT NULL CHECK (length(device_id) = 36),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REDEEMED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  redeemed_at TEXT,
  available_again_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip_hash TEXT,
  user_agent_hash TEXT,
  staff_action_id TEXT,
  CHECK (
    (status = 'ACTIVE' AND redeemed_at IS NULL AND available_again_at IS NULL)
    OR
    (status = 'REDEEMED' AND redeemed_at IS NOT NULL AND available_again_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS coupons_one_active_per_device_idx
  ON coupons (device_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS coupons_staff_action_id_idx
  ON coupons (staff_action_id)
  WHERE staff_action_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coupons_device_created_idx
  ON coupons (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS coupons_device_redeemed_idx
  ON coupons (device_id, redeemed_at DESC)
  WHERE status = 'REDEEMED';

CREATE TABLE IF NOT EXISTS coupon_rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'STATUS_CHECK', 'COUPON_ISSUE', 'RATE_LIMITED', 'COUPON_LOCKED',
    'REDEEM_ATTEMPT', 'REDEEM_SUCCESS', 'REDEEM_REJECTED',
    'REVIEW_REQUIRED'
  )),
  rate_key_hash TEXT,
  device_id TEXT,
  coupon_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  staff_action_id TEXT,
  success INTEGER CHECK (success IN (0, 1) OR success IS NULL),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
);

CREATE INDEX IF NOT EXISTS coupon_rate_events_device_time_idx
  ON coupon_rate_events (device_id, event_at DESC);

CREATE INDEX IF NOT EXISTS coupon_rate_events_coupon_time_idx
  ON coupon_rate_events (coupon_id, event_at DESC);

CREATE INDEX IF NOT EXISTS coupon_rate_events_ip_time_idx
  ON coupon_rate_events (ip_hash, event_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS coupon_rate_events_action_type_idx
  ON coupon_rate_events (staff_action_id, event_type)
  WHERE staff_action_id IS NOT NULL;
