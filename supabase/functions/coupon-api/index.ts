import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUPON_ID_RE = /^MS-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const encoder = new TextEncoder();

type JsonRecord = Record<string, unknown>;

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fail(code: string, status: number, extra: JsonRecord = {}): Response {
  return json({ ok: false, error: code, ...extra }, status);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function serviceKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, unknown>;
      const candidate = Object.values(parsed).find((value) => typeof value === "string");
      if (typeof candidate === "string" && candidate) return candidate;
    } catch {
      // Fall through to the legacy default when the platform has not migrated this project.
    }
  }
  return requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}

function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
}

function unwrapRpc(value: unknown): JsonRecord {
  if (Array.isArray(value)) return (value[0] ?? {}) as JsonRecord;
  return (value ?? {}) as JsonRecord;
}

async function rpc(
  client: ReturnType<typeof createClient>,
  functionName: string,
  args: JsonRecord,
): Promise<JsonRecord> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) throw new Error(`rpc_${functionName}`);
  return unwrapRpc(data);
}

async function readBody(request: Request): Promise<JsonRecord | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return fail("METHOD_NOT_ALLOWED", 405);

  const body = await readBody(request);
  if (!body) return fail("INVALID_REQUEST", 400);

  const action = body.action;
  const deviceId = body.device_id;
  if ((action !== "status" && action !== "redeem") || !isUuid(deviceId)) {
    return fail("INVALID_REQUEST", 400);
  }

  let projectUrl: string;
  let serviceRoleKey: string;
  let riskSecret: string;
  try {
    projectUrl = requiredEnv("SUPABASE_URL");
    serviceRoleKey = serviceKey();
    riskSecret = requiredEnv("MACHIDA_RISK_HASH_SECRET");
  } catch {
    return fail("SERVICE_UNAVAILABLE", 503);
  }

  const client = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ipHash = await hmacHex(riskSecret, `ip:${requestIp(request)}`);
  const userAgentHash = await hmacHex(
    riskSecret,
    `ua:${request.headers.get("user-agent") ?? "unknown"}`,
  );

  try {
    if (action === "status") {
      const result = await rpc(client, "issue_coupon", {
        p_device_id: deviceId,
        p_ip_hash: ipHash,
        p_user_agent_hash: userAgentHash,
      });
      const responseStatus = result.status === "RATE_LIMITED" ? 429 : 200;
      return json({ ok: responseStatus === 200, ...result }, responseStatus);
    }

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

    const redemption = await rpc(client, "redeem_coupon", {
      p_coupon_id: couponId,
      p_device_id: deviceId,
      p_staff_action_id: staffActionId,
      p_ip_hash: ipHash,
      p_user_agent_hash: userAgentHash,
      p_group_confirmed: groupConfirmed,
      p_no_other_promotion: noOtherPromotion,
    });
    if (redemption.status === "REDEEMED") return json({ ok: true, ...redemption });
    if (redemption.status === "ALREADY_REDEEMED") return fail("ALREADY_REDEEMED", 409, redemption);
    if (redemption.status === "REVIEW_REQUIRED") return fail("REVIEW_REQUIRED", 409, redemption);
    if (redemption.status === "DUPLICATE_REQUEST") return fail("DUPLICATE_REQUEST", 409, redemption);
    return fail("INVALID_COUPON", 409, redemption);
  } catch {
    // Do not disclose database errors or request contents. Redemption is fail-closed.
    return fail("SERVICE_UNAVAILABLE", 503);
  }
});
