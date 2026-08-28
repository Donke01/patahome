# Infobip — SMS

Sends the 6-digit SMS codes used to verify a user's phone number at signup.
Uses Infobip's HTTPS API (not SMPP), so it works on Railway where raw SMS/SMTP
ports are blocked.

- Dashboard: https://portal.infobip.com
- API docs: https://www.infobip.com/docs/api/channels/sms

## Env vars

| Variable            | Example                        | Notes |
|---------------------|--------------------------------|-------|
| `INFOBIP_API_KEY`   | `a1b2c3d4...`                  | Dashboard → Developer Tools → API keys |
| `INFOBIP_BASE_URL`  | `xyz123.api.infobip.com`       | Your personal base URL, shown on the API keys page. Protocol optional — the code strips `https://` if present. |
| `SMS_SENDER`        | `PataHome`                     | Alphanumeric sender ID. Optional; defaults to `PataHome`. |
| `PHONE_VERIFY`      | `off`                          | Kill switch — see below. Leave unset to keep verification on. |

## Turning phone verification off temporarily

Kenyan sender IDs need operator approval, and unapproved traffic gets throttled
or dropped. Rather than ripping the feature out while that's pending, set:

```
PHONE_VERIFY=off
```

With it off:

- Phone signup still works — no code is sent, nothing is blocked.
- `POST /api/listings` no longer requires a verified phone.
- The "Verify phone" item disappears from account settings (the client reads
  `phoneVerify` from `GET /api/config`).
- Existing `phone_verified` flags are **left untouched**, so re-enabling picks
  up exactly where it left off — nobody is retroactively marked verified.

Remove the variable to switch verification back on.

All three go into Railway → Variables. `smsConfigured()` in `lib.js` returns
true only when `INFOBIP_API_KEY` **and** `INFOBIP_BASE_URL` are both set — until
then signup silently skips the SMS step, so a missing key never blocks
registration.

## Sender ID registration (Kenya)

Kenya requires alphanumeric sender IDs to be pre-registered with the mobile
operators. Until `PataHome` is approved:

- Messages may be delivered from a shared numeric short code, or
- Messages may be rejected outright with a `REJECTED_*` status group.

Register the sender ID in the Infobip portal (Channels → SMS → Sender IDs) and
allow a few working days for Safaricom/Airtel approval. Test with the Infobip
simulator or your own number first.

## Send flow

`lib.js → sendSms({ to, text })`:

```
POST https://<INFOBIP_BASE_URL>/sms/2/text/advanced
Authorization: App <INFOBIP_API_KEY>
Content-Type: application/json

{ "messages": [ { "destinations": [{ "to": "254712345678" }],
                  "from": "PataHome",
                  "text": "123456 is your PataHome verification code…" } ] }
```

15-second timeout. Two failure paths are handled:

1. **HTTP error** — throws with Infobip's `requestError.serviceException.text`.
2. **HTTP 200 but message rejected** — Infobip still returns 200 when an
   individual message fails (bad number, unregistered sender, no route).
   `sendSms()` inspects `messages[0].status.groupName` and throws unless it is
   `PENDING` or `DELIVERED`.

## Phone normalisation

`normalizePhone()` converts what Kenyan users actually type into E.164 without
the plus, which is what Infobip expects:

| Input           | Sent as        |
|-----------------|----------------|
| `0712345678`    | `254712345678` |
| `+254712345678` | `254712345678` |
| `712345678`     | `254712345678` |
| `254712345678`  | `254712345678` |

## OTP flow

1. `POST /api/auth/register` → account created, `sendPhoneCode()` fires an SMS,
   response includes `phoneVerifyRequired: true` and `phoneTarget`.
2. Client opens the code entry step (`openPhoneVerify()` in `dashboard.html`).
3. `POST /api/auth/verify-phone/confirm` with `{ code }` → sets
   `users.phone_verified = 1`.
4. `POST /api/auth/verify-phone/send` resends (also used by the "Verify phone"
   item in account settings for users who skipped it).

Codes live in the shared `verify_codes` table with `kind='phone'`:
15-minute expiry, 5 attempts max, single-use, replaced on resend.

## Costs

Infobip bills per message segment. A 160-character GSM-7 message is one
segment; our OTP text fits comfortably. Watch the balance in the portal —
if it hits zero, sends fail and users can't complete signup. Consider setting
a low-balance alert.

## Gotchas

- **Never return 5xx** when SMS fails. Cloudflare replaces 502/503 with its own
  error page, hiding the real message. The endpoints return 400 with a readable
  reason. (Same standing rule as the rest of the codebase.)
- **Signup must not hard-fail on SMS errors.** `register` catches send failures
  and logs them — the account still exists and the user can resend from
  settings. Losing a signup because an SMS gateway hiccuped is worse than an
  unverified phone.
