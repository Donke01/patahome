# Google Sign-In — one-tap OAuth

Lets users sign up or log in with a Google account. We use the browser
"Sign in with Google" widget (GIS library) and verify the returned ID token
server-side.

- Console: https://console.cloud.google.com/apis/credentials
- Docs: https://developers.google.com/identity/gsi/web

## Env var

| Variable            | Purpose                                        |
|---------------------|------------------------------------------------|
| `GOOGLE_CLIENT_ID`  | OAuth 2.0 Client ID (ends in `.apps.googleusercontent.com`) |

## Console setup

1. Google Cloud Console → **APIs & Services → Credentials**.
2. Create Credentials → **OAuth client ID** → Application type: **Web**.
3. Authorized JavaScript origins:
   - `https://patahome.co.ke`
   - `https://www.patahome.co.ke`
   - `http://localhost:3000` (dev only)
4. Authorized redirect URIs: leave empty — we use ID token flow, not
   redirect flow.
5. Copy the client ID into Railway → `GOOGLE_CLIENT_ID`.

The OAuth consent screen must be **Published** (not "Testing") for any Google
user to sign in — testing mode limits it to the accounts you list.

## Verification flow (server side)

`POST /api/auth/google` receives `{credential}` — the ID token from the
browser widget. We verify it against Google's tokeninfo endpoint:

```
GET https://oauth2.googleapis.com/tokeninfo?id_token=<credential>
```

Checks: `aud === GOOGLE_CLIENT_ID`, `email_verified === "true"`, `exp` in
the future. On success we either look up an existing user by `google_id` /
email, or create one with a placeholder phone (`"g." + sub`) and
`email_verified = 1`.

## Gotcha — placeholder phone

The DB requires phone to be NOT NULL UNIQUE. Google-only users don't provide
a phone until they complete setup, so we insert `"g." + p.sub` (Google's
stable subject ID). The `realPhone()` helper hides this from the client, and
`needsSetup: !realPhone(...)` on the session tells the dashboard to prompt
for a real phone.

If a Google user later adds a real phone via account settings, we replace
the placeholder in-place — no row change, just an UPDATE.
