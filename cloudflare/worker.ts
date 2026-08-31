/// <reference types="@cloudflare/workers-types" />

type JsonRecord = Record<string, unknown>;

type CouponRecord = {
  coupon_id: string;
  device_id: string;
  status: "ACTIVE" | "REDEEMED";
  created_at: string;
  redeemed_at: string | null;
  available_again_at: string | null;
  updated_at: string;
  staff_action_id: string | null;
};

type EventFields = {
  eventType: string;
  deviceId?: string | null;
  couponId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  staffActionId?: string | null;
  success?: boolean | null;
  metadata?: JsonRecord;
};

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  MACHIDA_RISK_HASH_SECRET?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUPON_ID_RE = /^MS-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const encoder = new TextEncoder();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function fail(error: string, status: number, extra: JsonRecord = {}): Response {
  return json({ ok: false, error, ...extra }, status);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function makeUuid(): string {
  return crypto.randomUUID();
}

function makeCouponId(): string {
  const compact = makeUuid().replaceAll("-", "").toUpperCase();
  return `MS-${compact.slice(0, 4)}-${compact.slice(4, 8)}`;
}

function requestIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Real-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
}

function safeMetadata(metadata: JsonRecord | undefined): string {
  return JSON.stringify(metadata ?? {});
}

function getRiskSecret(env: Env): string | null {
  const secret = env.MACHIDA_RISK_HASH_SECRET?.trim();
  return secret ? secret : null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return hex(new Uint8Array(signature));
}

async function readBody(request: Request): Promise<JsonRecord | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

async function first<T>(db: D1Database, query: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(query).bind(...values).first<T>();
}

async function count(db: D1Database, query: string, ...values: unknown[]): Promise<number> {
  const row = await first<{ count: number | string }>(db, query, ...values);
  return Number(row?.count ?? 0);
}

async function recordEvent(env: Env, fields: EventFields): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO coupon_rate_events
      (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
       staff_action_id, success, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fields.eventType,
    fields.deviceId ?? null,
    fields.couponId ?? null,
    fields.ipHash ?? null,
    fields.userAgentHash ?? null,
    fields.staffActionId ?? null,
    fields.success === undefined || fields.success === null ? null : fields.success ? 1 : 0,
    safeMetadata(fields.metadata),
  ).run();
}

async function findActive(env: Env, deviceId: string): Promise<CouponRecord | null> {
  return first<CouponRecord>(env.DB, `
    SELECT coupon_id, device_id, status, created_at, redeemed_at,
           available_again_at, updated_at, staff_action_id
    FROM coupons
    WHERE device_id = ? AND status = 'ACTIVE'
    ORDER BY created_at DESC
    LIMIT 1
  `, deviceId);
}

async function findLocked(env: Env, deviceId: string): Promise<CouponRecord | null> {
  return first<CouponRecord>(env.DB, `
    SELECT coupon_id, device_id, status, created_at, redeemed_at,
           available_again_at, updated_at, staff_action_id
    FROM coupons
    WHERE device_id = ?
      AND status = 'REDEEMED'
      AND available_again_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY redeemed_at DESC
    LIMIT 1
  `, deviceId);
}

async function findByCouponId(env: Env, couponId: string): Promise<CouponRecord | null> {
  return first<CouponRecord>(env.DB, `
    SELECT coupon_id, device_id, status, created_at, redeemed_at,
           available_again_at, updated_at, staff_action_id
    FROM coupons
    WHERE coupon_id = ?
    LIMIT 1
  `, couponId);
}

async function findByStaffActionId(env: Env, staffActionId: string): Promise<CouponRecord | null> {
  return first<CouponRecord>(env.DB, `
    SELECT coupon_id, device_id, status, created_at, redeemed_at,
           available_again_at, updated_at, staff_action_id
    FROM coupons
    WHERE staff_action_id = ?
    LIMIT 1
  `, staffActionId);
}

function activeResponse(coupon: CouponRecord): JsonRecord {
  return {
    status: "ACTIVE",
    coupon_id: coupon.coupon_id,
    created_at: coupon.created_at,
  };
}

function redeemedResponse(coupon: CouponRecord): JsonRecord {
  return {
    status: "REDEEMED",
    coupon_id: coupon.coupon_id,
    redeemed_at: coupon.redeemed_at,
    available_again_at: coupon.available_again_at,
  };
}

function lockedResponse(coupon: CouponRecord): JsonRecord {
  return {
    status: "LOCKED",
    coupon_id: coupon.coupon_id,
    redeemed_at: coupon.redeemed_at,
    available_again_at: coupon.available_again_at,
  };
}

async function handleStatus(
  env: Env,
  deviceId: string,
  ipHash: string,
  userAgentHash: string,
): Promise<Response> {
  const recentIssueEvents = await count(env.DB, `
    SELECT COUNT(*) AS count
    FROM coupon_rate_events
    WHERE device_id = ?
      AND event_type IN ('STATUS_CHECK', 'COUPON_ISSUE')
      AND event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
  `, deviceId);
  if (recentIssueEvents >= 12) {
    await recordEvent(env, {
      eventType: "RATE_LIMITED",
      deviceId,
      ipHash,
      userAgentHash,
      success: false,
      metadata: { scope: "coupon_issue" },
    });
    return fail("RATE_LIMITED", 429, { status: "RATE_LIMITED" });
  }

  const locked = await findLocked(env, deviceId);
  if (locked) {
    await recordEvent(env, {
      eventType: "COUPON_LOCKED",
      deviceId,
      couponId: locked.coupon_id,
      ipHash,
      userAgentHash,
      success: false,
      metadata: { scope: "14_day_lock" },
    });
    return json({ ok: true, ...lockedResponse(locked) });
  }

  const active = await findActive(env, deviceId);
  if (active) {
    await recordEvent(env, {
      eventType: "STATUS_CHECK",
      deviceId,
      couponId: active.coupon_id,
      ipHash,
      userAgentHash,
      success: true,
      metadata: { scope: "existing_active" },
    });
    return json({ ok: true, ...activeResponse(active) });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generatedCouponId = makeCouponId();
    try {
      await env.DB.prepare(`
        INSERT INTO coupons (coupon_id, device_id, status)
        VALUES (?, ?, 'ACTIVE')
      `).bind(generatedCouponId, deviceId).run();
    } catch {
      const concurrentActive = await findActive(env, deviceId);
      if (concurrentActive) {
        return json({ ok: true, ...activeResponse(concurrentActive) });
      }
      continue;
    }

    const created = await findByCouponId(env, generatedCouponId);
    if (!created) return fail("SERVICE_UNAVAILABLE", 503);
    await recordEvent(env, {
      eventType: "COUPON_ISSUE",
      deviceId,
      couponId: created.coupon_id,
      ipHash,
      userAgentHash,
      success: true,
      metadata: { scope: "new_session" },
    });
    return json({ ok: true, ...activeResponse(created) });
  }

  return fail("SERVICE_UNAVAILABLE", 503);
}

async function handleRedeem(
  env: Env,
  body: JsonRecord,
  deviceId: string,
  ipHash: string,
  userAgentHash: string,
): Promise<Response> {
  const couponId = body.coupon_id;
  const staffActionId = body.staff_action_id;
  const groupConfirmed = body.group_confirmed;
  const noOtherPromotion = body.no_other_promotion;
  if (
    typeof couponId !== "string" || !COUPON_ID_RE.test(couponId) ||
    !isUuid(staffActionId) || typeof groupConfirmed !== "boolean" ||
    typeof noOtherPromotion !== "boolean"
  ) {
    return fail("INVALID_REQUEST", 400);
  }

  const coupon = await findByCouponId(env, couponId);
  if (!coupon || coupon.device_id !== deviceId) {
    await recordEvent(env, {
      eventType: "REDEEM_REJECTED",
      deviceId,
      couponId,
      ipHash,
      userAgentHash,
      staffActionId,
      success: false,
      metadata: { reason: "invalid_coupon" },
    });
    return fail("INVALID_COUPON", 409, { status: "INVALID_COUPON" });
  }

  const priorAction = await findByStaffActionId(env, staffActionId);
  if (priorAction) {
    if (
      priorAction.coupon_id === couponId &&
      priorAction.device_id === deviceId &&
      priorAction.status === "REDEEMED"
    ) {
      return json({ ok: true, ...redeemedResponse(priorAction) });
    }
    return fail("DUPLICATE_REQUEST", 409, { status: "DUPLICATE_REQUEST" });
  }

  if (coupon.status !== "ACTIVE") {
    return fail("ALREADY_REDEEMED", 409, {
      ok: false,
      ...redeemedResponse(coupon),
    });
  }

  if (groupConfirmed !== true || noOtherPromotion !== true) {
    await recordEvent(env, {
      eventType: "REVIEW_REQUIRED",
      deviceId,
      couponId,
      ipHash,
      userAgentHash,
      staffActionId,
      success: false,
      metadata: { reason: "staff_check_incomplete" },
    });
    return fail("REVIEW_REQUIRED", 409, { status: "REVIEW_REQUIRED" });
  }

  const recentDeviceAttempts = await count(env.DB, `
    SELECT COUNT(*) AS count
    FROM coupon_rate_events
    WHERE device_id = ?
      AND event_type = 'REDEEM_ATTEMPT'
      AND event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
  `, deviceId);
  const recentCouponAttempts = await count(env.DB, `
    SELECT COUNT(*) AS count
    FROM coupon_rate_events
    WHERE coupon_id = ?
      AND event_type = 'REDEEM_ATTEMPT'
      AND event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
  `, couponId);
  const recentIpAttempts = await count(env.DB, `
    SELECT COUNT(*) AS count
    FROM coupon_rate_events
    WHERE ip_hash = ?
      AND event_type = 'REDEEM_ATTEMPT'
      AND event_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
  `, ipHash);
  if (recentDeviceAttempts >= 3 || recentCouponAttempts >= 3 || recentIpAttempts >= 12) {
    await recordEvent(env, {
      eventType: "REVIEW_REQUIRED",
      deviceId,
      couponId,
      ipHash,
      userAgentHash,
      staffActionId,
      success: false,
      metadata: { reason: "redemption_rate_limit" },
    });
    return fail("REVIEW_REQUIRED", 409, { status: "REVIEW_REQUIRED" });
  }

  await recordEvent(env, {
    eventType: "REDEEM_ATTEMPT",
    deviceId,
    couponId,
    ipHash,
    userAgentHash,
    staffActionId,
    success: true,
    metadata: { scope: "redemption" },
  });

  const batch = await env.DB.batch([
    env.DB.prepare(`
      UPDATE coupons
      SET status = 'REDEEMED',
          redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          available_again_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+14 days'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          ip_hash = ?,
          user_agent_hash = ?,
          staff_action_id = ?
      WHERE coupon_id = ?
        AND device_id = ?
        AND status = 'ACTIVE'
        AND redeemed_at IS NULL
        AND available_again_at IS NULL
    `).bind(ipHash, userAgentHash, staffActionId, couponId, deviceId),
    env.DB.prepare(`
      INSERT INTO coupon_rate_events
        (event_type, device_id, coupon_id, ip_hash, user_agent_hash,
         staff_action_id, success, metadata)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?
      WHERE changes() = 1
    `).bind(
      "REDEEM_SUCCESS", deviceId, couponId, ipHash, userAgentHash,
      staffActionId, safeMetadata({ scope: "redemption" }),
    ),
  ]);
  const changed = Number(batch[0]?.meta?.changes ?? 0);
  const after = await findByCouponId(env, couponId);
  if (changed !== 1 || !after) {
    if (after?.status === "REDEEMED") {
      return fail("ALREADY_REDEEMED", 409, { ok: false, ...redeemedResponse(after) });
    }
    return fail("SERVICE_UNAVAILABLE", 503);
  }

  return json({ ok: true, ...redeemedResponse(after) });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return fail("METHOD_NOT_ALLOWED", 405);

  const body = await readBody(request);
  if (!body) return fail("INVALID_REQUEST", 400);
  const action = body.action;
  const deviceId = body.device_id;
  if ((action !== "status" && action !== "redeem") || !isUuid(deviceId)) {
    return fail("INVALID_REQUEST", 400);
  }

  const riskSecret = getRiskSecret(env);
  if (!riskSecret) return fail("SERVICE_UNAVAILABLE", 503);

  try {
    const [ipHash, userAgentHash] = await Promise.all([
      hmacHex(riskSecret, `ip:${requestIp(request)}`),
      hmacHex(riskSecret, `ua:${request.headers.get("User-Agent") ?? "unknown"}`),
    ]);
    if (action === "status") return handleStatus(env, deviceId, ipHash, userAgentHash);
    return handleRedeem(env, body, deviceId, ipHash, userAgentHash);
  } catch {
    // Never disclose D1 errors or request contents. All failures fail closed.
    return fail("SERVICE_UNAVAILABLE", 503);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/coupon" || url.pathname === "/api/coupon/") {
      return handleApi(request, env);
    }
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return fail("SERVICE_UNAVAILABLE", 503);
    }
  },
};

export default worker;
