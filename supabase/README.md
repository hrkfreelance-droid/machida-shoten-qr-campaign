# Machida Shoten QR Coupon backend

This directory belongs to the dedicated Supabase project `machida-qr-coupon`
(`qzlaqnteaxzkgqfhcxtu`) in `hrk.freelance@gmail.com's Org`.

The migration is intentionally isolated from the existing Supabase project.
The public campaign must call the `coupon-api` Edge Function; browser code must
never receive a service-role key or staff code.

Required server secrets:

- `MACHIDA_STAFF_CODE_HASH` — HMAC-SHA-256 digest of the current staff code,
  using the server-only pepper.
- `MACHIDA_STAFF_CODE_PEPPER` — random server-only pepper for staff-code
  comparison.
- `MACHIDA_RISK_HASH_SECRET` — random server-only HMAC key for IP, user-agent,
  and rate-key pseudonyms.

The production staff code is not configured in source control. If the staff
code secret is absent, the Edge Function fails closed and does not redeem.
