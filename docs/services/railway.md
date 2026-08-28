# Railway — hosting

Where the Node.js app runs in production.

- Dashboard: https://railway.app
- Project: `patahome-backend` (linked to this GitHub repo)
- Public URL: proxied behind Cloudflare → https://patahome.co.ke

## Deploy config

Railway auto-detects Node from `package.json`. We override the start command
so the DB is seeded on every boot (idempotent — safe to re-run).

```
startCommand: "node seed.js && node server.js"
```

Nothing to build — no bundler, no TypeScript. Node 22.5+ is required for
`node:sqlite`.

## Environment variables

Set these under **Variables** in the Railway service:

| Variable                | Purpose                                              |
|-------------------------|------------------------------------------------------|
| `PORT`                  | Railway injects automatically — do not set manually  |
| `DB_PATH`               | `/data/patahome.db` (must live on the volume)        |
| `JWT_SECRET`            | Long random string; rotates all sessions if changed  |
| `BASE_URL`              | `https://patahome.co.ke`                             |
| `ADMIN_PHONE`           | Seeded admin login (default `0700000001`)            |
| `ADMIN_PASSWORD`        | Seeded admin password — set this, do not use default |
| `SEED_DEMO`             | `0` in prod; `1` locally to load demo listings       |
| `RESEND_API_KEY`        | See `resend.md`                                      |
| `MAIL_FROM`             | `info@patahome.co.ke`                                |
| `CLOUDINARY_CLOUD_NAME` | See `cloudinary.md`                                  |
| `CLOUDINARY_API_KEY`    | See `cloudinary.md`                                  |
| `CLOUDINARY_API_SECRET` | See `cloudinary.md`                                  |
| `GOOGLE_CLIENT_ID`      | See `google-signin.md`                               |
| `INFOBIP_API_KEY`       | See `infobip.md`                                     |
| `INFOBIP_BASE_URL`      | See `infobip.md` — e.g. `xyz123.api.infobip.com`     |
| `PHONE_VERIFY`          | Set to `off` to pause SMS verification; unset to enable |
| `SMS_SENDER`            | Alphanumeric sender ID, defaults to `PataHome`       |

## Persistent volume (critical)

The SQLite database MUST live on a Railway Volume, otherwise every redeploy
resets user data.

1. Service → Settings → **Volumes** → New Volume
2. Mount path: `/data`
3. `DB_PATH` env var: `/data/patahome.db`

To verify after deploy: sign up a test user, redeploy, then log in again — if
the login still works, the volume is wired correctly.

## Gotchas

- **Outbound SMTP is blocked.** Ports 587 and 465 both time out from Railway
  containers. That's why we use Resend's HTTPS API for email. Don't waste time
  trying to make raw SMTP work here.
- **No shell in the free tier.** Use `railway run` from the CLI locally
  (`npm i -g @railway/cli`; `railway login`; `railway link`; `railway run
  node scripts/whatever.js`) to run one-off scripts against production env
  vars.
- **Cold starts** are ~1-2 s. Fine for a marketplace, but don't be surprised
  by the first request after idle.
