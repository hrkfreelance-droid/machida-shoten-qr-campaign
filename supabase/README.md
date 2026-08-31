# Machida Shoten QR Coupon backend

This directory belongs to the dedicated Supabase project `machida-qr-coupon`
(`qzlaqnteaxzkgqfhcxtu`) in `hrk.freelance@gmail.com's Org`.

The migration is intentionally isolated from the existing Supabase project.
The public campaign must call the `coupon-api` Edge Function; browser code must
never receive a service-role key. Redemption is confirmed by the staff-only
slider flow and completed server-side.

Required server secrets:

- `MACHIDA_RISK_HASH_SECRET` — random server-only HMAC key for IP, user-agent,
  and rate-key pseudonyms.

The legacy `coupon_staff_lockouts` table and `record_staff_attempt` database
function are retained for rollback/audit only. They are not referenced by the
active Edge Function or redemption path.
