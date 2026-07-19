# PataHome — External services

Everything third-party the app depends on, in one place. Each file below is a
short reference: what the service does for us, where to log in, the env vars
we set on the host, and gotchas learned the hard way.

## Services

| # | Service          | Role                                         | File                        |
|---|------------------|----------------------------------------------|-----------------------------|
| 1 | Railway          | Node.js host + persistent volume for SQLite  | `railway.md`                |
| 2 | Cloudflare       | DNS + reverse proxy in front of the domain   | `cloudflare.md`             |
| 3 | Resend           | Transactional email (OTP, notifications)     | `resend.md`                 |
| 4 | Cloudinary       | Photo + verification doc storage             | `cloudinary.md`             |
| 5 | Google Sign-In   | OAuth for one-click signup / login           | `google-signin.md`          |
| 6 | Domain + iCloud  | patahome.co.ke registrar + inbox hosting     | `domain-and-icloud.md`      |

## Complete env var reference

See `env.example` in this folder — one file, every variable, with comments and
which service each belongs to. Copy it to `.env` for local dev or paste each
key into Railway's Variables tab for production.

## Golden rules learned along the way

1. **Never return 5xx status codes for user-facing API errors.** Cloudflare
   replaces every 502/503 with its own generic error page, hiding the real
   message. Use 400 for validation and 401 for auth. This is enforced across
   `server.js`.
2. **Railway blocks outbound SMTP ports** (587, 465). Email goes through the
   Resend HTTPS API — SMTP is only a local-dev fallback in `lib.js`.
3. **The SQLite file lives on a Railway Volume**, not the ephemeral container
   filesystem. `DB_PATH` must point at the mounted volume, otherwise every
   redeploy wipes user data.
4. **Rotate any secret that ends up in chat, email, or a commit.** The Resend
   API key was pasted in chat once — treat it as burned and generate a new one
   in the Resend dashboard.
