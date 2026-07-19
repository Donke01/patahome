# Resend — transactional email

Sends OTP codes, verification emails, and system notifications. Uses Resend's
HTTPS API (not SMTP), which is the only reliable path from Railway since the
host blocks SMTP ports.

- Dashboard: https://resend.com
- Docs: https://resend.com/docs

## Env vars

| Variable         | Example                          |
|------------------|----------------------------------|
| `RESEND_API_KEY` | `re_xxxxxxxx_xxxxxxxxxxxxxxxxxx` |
| `MAIL_FROM`      | `info@patahome.co.ke`            |

Both must be set for `mailConfigured()` in `lib.js` to return true. When
false, listing creation still works but email OTP is skipped.

## Domain setup

For `MAIL_FROM=info@patahome.co.ke` to work, the domain must be verified in
Resend:

1. Resend dashboard → **Domains** → Add `patahome.co.ke`
2. Copy the DNS records Resend shows (TXT for SPF, CNAME for DKIM, TXT for
   DMARC) and add them at Cloudflare with proxy **OFF** (grey cloud).
3. Wait for Resend to mark all three records "Verified" (usually minutes).

Until verified, Resend returns 403 and no mail is sent.

## Send flow

`lib.js → sendMail({to, subject, text})`:

```js
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Body: { from: "PataHome <info@patahome.co.ke>", to: [...], subject, text }
```

15-second timeout via `AbortSignal.timeout(15000)`. On non-OK response, throws
with Resend's error message so the caller returns a clean 400 to the user.

## SMTP fallback (local dev only)

`lib.js` still contains a raw SMTP client (`smtpSend`). If `RESEND_API_KEY`
is unset but `SMTP_HOST/USER/PASS` are all set, it will try STARTTLS on 587
(or implicit TLS on 465). This path exists for local testing only — do not
rely on it in production.

## Key rotation

If a key ever leaks (pasted in chat, committed, screenshotted):

1. Resend dashboard → **API Keys** → revoke the old one.
2. Create a new key, copy it once.
3. Paste directly into Railway → **Variables** → `RESEND_API_KEY`. Never
   through chat with an assistant, never into a git-tracked file.
