# Domain + iCloud mail

## Domain — patahome.co.ke

- Registrar: KENIC / .KE reseller (renew annually)
- Nameservers: pointed at Cloudflare (see `cloudflare.md`)

Renewal is the only recurring task here. If nameservers ever drift back to
the registrar defaults, TLS breaks and the site 526s — check nameservers
first when the domain suddenly fails.

## Mailboxes — iCloud custom domain

Real mailboxes for the business live on iCloud+ Custom Email Domain:

| Address              | Owner                              |
|----------------------|------------------------------------|
| `info@patahome.co.ke`| Shared inbox                       |
| `don@patahome.co.ke` | Founder                            |

- Setup: iCloud.com → **Custom Email Domain** → add `patahome.co.ke` and
  publish the MX / SPF / DKIM records shown to Cloudflare (grey cloud —
  mail records must not be proxied).

These are for **receiving** and human sending only. Transactional email
(OTP codes, notifications) goes through Resend using `MAIL_FROM=info@...`,
which needs its own SPF/DKIM records — Resend and iCloud can coexist as
long as both DKIM CNAMEs are present.

## SMTP from the app? No.

Originally the app tried to send via iCloud SMTP (`smtp.mail.me.com:587`
with an app-specific password). This failed on Railway because outbound
SMTP is blocked. We kept the SMTP client in `lib.js` as a local-dev
fallback only — production always uses Resend.
